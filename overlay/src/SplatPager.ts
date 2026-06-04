import * as THREE from "three";

import init_wasm, { decode_rad_header } from "spark-rs";
import { LN_SCALE_MAX, LN_SCALE_MIN, dyno } from ".";
import { evaluateExtSH } from "./ExtSplats";
import { evaluatePackedSH } from "./PackedSplats";
import { getSplatFileType, getSplatFileTypeFromPath } from "./SplatLoader";
import type { SplatSource } from "./SplatMesh";
import { workerPool } from "./SplatWorker";
import {
  DEFAULT_SPLAT_ENCODING,
  type ExtResult,
  type PackedResult,
  type RadMeta,
  type SplatEncoding,
  SplatFileType,
} from "./defines";
import { pagedSplatTexCoord } from "./dyno";
import { getTextureSize } from "./utils";

function emitExperimentEvent(
  type: string,
  payload: Record<string, unknown>,
): void {
  if (typeof window === "undefined") return;
  const hook = (window as Window & { __sparkExpEvent?: (evt: unknown) => void })
    .__sparkExpEvent;
  if (!hook) return;
  try {
    hook({ type, ...payload });
  } catch {
    // instrumentation is best effort and must not affect rendering path
  }
}

export interface PagedSplatsOptions {
  pager?: SplatPager;
  rootUrl?: string;
  requestHeader?: Record<string, string>;
  withCredentials?: boolean;
  fileBytes?: Uint8Array;
  fileType?: SplatFileType;
  maxSh?: number;
}

export class PagedSplats implements SplatSource {
  pager?: SplatPager;
  rootUrl: string;
  requestHeader?: Record<string, string>;
  withCredentials?: boolean;
  fileBytes?: Uint8Array;
  fileType?: SplatFileType;

  numSh: number;
  maxSh: number;
  sh1Codes?: Uint32Array;
  sh2Codes?: Uint32Array;
  sh3Codes?: Uint32Array | [Uint32Array, Uint32Array];

  numSplats: number;
  splatEncoding?: SplatEncoding;
  radMetaPromise?: Promise<{ meta: RadMeta; chunksStart: number }>;

  dynoNumSplats: dyno.DynoInt<"numSplats">;
  dynoIndices: dyno.DynoUsampler2D<"indices", THREE.DataTexture>;
  rgbMinMaxLnScaleMinMax: dyno.DynoVec4<
    THREE.Vector4,
    "rgbMinMaxLnScaleMinMax"
  >;
  lodOpacity: dyno.DynoBool<"lodOpacity">;
  dynoNumSh: dyno.DynoInt<"numSh">;
  shMax: dyno.DynoVec3<THREE.Vector3, "shMax">;

  constructor(options: PagedSplatsOptions) {
    this.pager = options.pager;
    this.rootUrl = options.rootUrl ?? "";
    this.requestHeader = options.requestHeader;
    this.withCredentials = options.withCredentials;
    this.numSh = 0;
    this.maxSh = options.pager?.maxSh ?? 3;

    this.numSplats = 0;

    this.dynoNumSplats = new dyno.DynoInt({ value: 0 });
    this.dynoIndices = new dyno.DynoUsampler2D({
      value: SplatPager.emptyIndicesTexture,
    });

    this.rgbMinMaxLnScaleMinMax = new dyno.DynoVec4({
      value: new THREE.Vector4(0.0, 1.0, LN_SCALE_MIN, LN_SCALE_MAX),
    });
    this.lodOpacity = new dyno.DynoBool({
      value: false,
    });

    this.dynoNumSh = new dyno.DynoInt({ value: 0 });
    this.shMax = new dyno.DynoVec3({ value: new THREE.Vector3() });

    this.fileBytes = options.fileBytes;
    this.fileType = options.fileType;
    if (!this.fileType && this.fileBytes) {
      this.fileType = getSplatFileType(this.fileBytes);
    }
    if (!this.fileType && this.rootUrl) {
      this.fileType = getSplatFileTypeFromPath(this.rootUrl);
    }
    if (!this.fileType) {
      throw new Error("Unable to determine file type");
    }
    if (this.fileType === SplatFileType.RAD) {
      this.radMetaPromise = this.getRadMeta();
    }
  }

  dispose() {
    if (this.dynoIndices.value !== SplatPager.emptyIndicesTexture) {
      this.dynoIndices.value.dispose();
      this.dynoIndices.value = SplatPager.emptyIndicesTexture;
    }
  }

  setMaxSh(maxSh: number) {
    this.maxSh = maxSh;
  }

  getRadMeta(): Promise<{ meta: RadMeta; chunksStart: number }> {
    if (this.radMetaPromise) {
      return this.radMetaPromise;
    }

    this.radMetaPromise = (async () => {
      await wasmInitialized;

      if (this.fileBytes) {
        // Shouldn't be more than 1 MB, so don't send more data than that.
        const metaStart = decode_rad_header(this.fileBytes.slice(0, 1048576));
        if (metaStart) {
          return metaStart;
        }
        throw new Error("Failed to decode RAD header");
      }
      if (!this.rootUrl) {
        throw new Error("No url or fileBytes provided");
      }

      // We don't know how big the header will be. Most likely 64KB will be enough,
      // but try larger blocks in backoff if it wasn't enough.
      for (const tryBytes of [65536, 256 * 1024, 1024 * 1024]) {
        const bytes = await fetchRange({
          url: this.rootUrl,
          requestHeader: this.requestHeader,
          withCredentials: this.withCredentials,
          offset: 0,
          bytes: tryBytes,
        });
        const metaStart = decode_rad_header(bytes);
        if (metaStart) {
          return metaStart;
        }
      }
      throw new Error("Failed to decode RAD header");
    })().then((metaStart) => {
      // console.log("RAD meta: ", metaStart.meta);
      return metaStart;
    });

    this.radMetaPromise.catch((error) => {
      console.error(error);
      // Allow it to be tried again
      // this.radMetaPromise = undefined;
    });

    return this.radMetaPromise;
  }

  chunkUrl(chunk: number): string {
    return this.rootUrl.replace(/-lod-0\./, `-lod-${chunk}.`);
  }

  async fetchDecodeChunk(chunk: number) {
    // v2 ready-aware loader hook (paper_materials/proactive_single_user_v2):
    // If the page has pre-decoded this chunk via a controller that ran
    // workerPool.call ahead of time, return the cached lodSplats and replicate
    // the first-chunk side effects so subsequent chunks see splatEncoding.
    const win = window as Window & {
      __sparkPrefetchedDecoded?: Record<string, Map<number, unknown>>;
    };
    const sparkReady = win.__sparkPrefetchedDecoded;
    if (sparkReady && this.rootUrl) {
      const bucket = sparkReady[this.rootUrl];
      if (bucket && bucket.has(chunk)) {
        const cached = bucket.get(chunk) as {
          lodSplats?: { extra?: { sh1Codes?: unknown; sh2Codes?: unknown; sh3Codes?: unknown; sh1?: unknown; sh2?: unknown; sh3?: unknown; sh3a?: unknown; sh3b?: unknown }; splatEncoding?: unknown };
        };
        const lodSplats = cached?.lodSplats ?? (cached as unknown);
        if (lodSplats) {
          const ls = lodSplats as {
            extra?: { sh1Codes?: unknown; sh2Codes?: unknown; sh3Codes?: unknown; sh1?: unknown; sh2?: unknown; sh3?: unknown; sh3a?: unknown; sh3b?: unknown };
            splatEncoding?: { rgbMin?: number; rgbMax?: number; lnScaleMin?: number; lnScaleMax?: number; lodOpacity?: boolean; sh1Max?: number; sh2Max?: number; sh3Max?: number };
            numSplats?: number;
          };
          if (!this.splatEncoding && ls.splatEncoding) {
            this.splatEncoding = ls.splatEncoding as SplatEncoding;
            this.numSh = ls.extra?.sh3a && ls.extra?.sh3b
              ? 3
              : ls.extra?.sh3
                ? 3
                : ls.extra?.sh2
                  ? 2
                  : ls.extra?.sh1
                    ? 1
                    : 0;
            this.rgbMinMaxLnScaleMinMax.value.set(
              ls.splatEncoding.rgbMin ?? 0.0,
              ls.splatEncoding.rgbMax ?? 1.0,
              ls.splatEncoding.lnScaleMin ?? LN_SCALE_MIN,
              ls.splatEncoding.lnScaleMax ?? LN_SCALE_MAX,
            );
            this.lodOpacity.value = ls.splatEncoding.lodOpacity ?? false;
            this.shMax.value.set(
              ls.splatEncoding.sh1Max ?? 1.0,
              ls.splatEncoding.sh2Max ?? 1.0,
              ls.splatEncoding.sh3Max ?? 1.0,
            );
          }
          this.sh1Codes = (ls.extra?.sh1Codes as typeof this.sh1Codes) ?? this.sh1Codes;
          this.sh2Codes = (ls.extra?.sh2Codes as typeof this.sh2Codes) ?? this.sh2Codes;
          this.sh3Codes = (ls.extra?.sh3Codes as typeof this.sh3Codes) ?? this.sh3Codes;
          return lodSplats as PackedResult;
        }
      }
    }
    let decodeBytes = undefined;

    if (this.fileType === SplatFileType.RAD) {
      const { meta, chunksStart } = await this.getRadMeta();
      if (chunk < 0 || chunk >= meta.chunks.length) {
        throw new Error(
          `Chunk index out of range: ${chunk} (max: ${meta.chunks.length - 1})`,
        );
      }
      let { offset, bytes, filename } = meta.chunks[chunk];

      if (filename) {
        if (this.fileBytes) {
          throw new Error("Chunked RAD file not supported with fileBytes");
        }
        const resolvedRoot = new URL(
          this.rootUrl,
          window.location.href,
        ).toString();
        const chunkUrl = new URL(filename, resolvedRoot).toString();
        decodeBytes = await fetchRange({
          url: chunkUrl,
          requestHeader: this.requestHeader,
          withCredentials: this.withCredentials,
        });
      } else {
        offset += chunksStart;
        if (this.fileBytes) {
          if (offset < 0 || offset + bytes > this.fileBytes.length) {
            throw new Error(
              `Invalid chunk offset or bytes: ${offset} + ${bytes} > ${this.fileBytes.length}`,
            );
          }
          decodeBytes = this.fileBytes.slice(offset, offset + bytes);
        } else if (this.rootUrl) {
          // Range Coalescing: read K from window.__sparkCoalesceK (default 1 = no coalesce)
          const coalesceK = (window as Window & { __sparkCoalesceK?: number }).__sparkCoalesceK ?? 1;
          if (coalesceK > 1) {
            decodeBytes = await fetchRangeCoalesced({
              url: this.rootUrl,
              requestHeader: this.requestHeader,
              withCredentials: this.withCredentials,
              chunkIdx: chunk,
              meta,
              chunksStart,
              maxCoalesce: coalesceK,
            });
          } else {
            decodeBytes = await fetchRange({
              url: this.rootUrl,
              requestHeader: this.requestHeader,
              withCredentials: this.withCredentials,
              offset,
              bytes,
            });
          }
        } else {
          throw new Error("No url or fileBytes provided");
        }
      }
    } else if (this.fileBytes) {
      // Fall through
    } else if (this.rootUrl) {
      const url = this.chunkUrl(chunk);
      const request = new Request(url, {
        headers: this.requestHeader
          ? new Headers(this.requestHeader)
          : undefined,
        credentials: this.withCredentials ? "include" : "same-origin",
      });
      const response = await fetch(request);
      if (!response.ok || !response.body) {
        throw new Error(
          `Failed to fetch "${url}": ${response.status} ${response.statusText}`,
        );
      }
      decodeBytes = new Uint8Array(await response.arrayBuffer());
    } else {
      throw new Error("No url or fileBytes provided");
    }

    const chunkObjectId = `${this.rootUrl || "unknown"}#chunk-${chunk}`;
    emitExperimentEvent("parse_start", {
      object_id: chunkObjectId,
      chunk,
      parse_start_ts_ms: Date.now(),
    });

    return await workerPool.withWorker(async (worker) => {
      if (!this.pager) {
        throw new Error("PagedSplats.pager not set");
      }
      if (!this.pager.extSplats) {
        const result = (await worker.call("loadPackedSplats", {
          fileBytes: decodeBytes,
          pathName: this.chunkUrl(chunk),
          sh1Codes: this.sh1Codes?.slice(),
          sh2Codes: this.sh2Codes?.slice(),
          sh3Codes: this.sh3Codes?.slice(),
        })) as { lodSplats: PackedResult };
        const lodSplats = result.lodSplats;
        if (!this.splatEncoding) {
          this.splatEncoding = lodSplats.splatEncoding;

          this.numSh = lodSplats.extra.sh3
            ? 3
            : lodSplats.extra.sh2
              ? 2
              : lodSplats.extra.sh1
                ? 1
                : 0;

          this.rgbMinMaxLnScaleMinMax.value.set(
            this.splatEncoding.rgbMin ?? 0.0,
            this.splatEncoding.rgbMax ?? 1.0,
            this.splatEncoding.lnScaleMin ?? LN_SCALE_MIN,
            this.splatEncoding.lnScaleMax ?? LN_SCALE_MAX,
          );

          this.lodOpacity.value = this.splatEncoding.lodOpacity ?? false;

          this.shMax.value.set(
            this.splatEncoding.sh1Max ?? 1.0,
            this.splatEncoding.sh2Max ?? 1.0,
            this.splatEncoding.sh3Max ?? 1.0,
          );
        }
        this.sh1Codes = lodSplats.extra.sh1Codes ?? this.sh1Codes;
        this.sh2Codes = lodSplats.extra.sh2Codes ?? this.sh2Codes;
        this.sh3Codes = lodSplats.extra.sh3Codes ?? this.sh3Codes;
        emitExperimentEvent("parse_complete", {
          object_id: chunkObjectId,
          chunk,
          num_splats: lodSplats.numSplats,
          parse_complete_ts_ms: Date.now(),
        });
        return lodSplats;
      }

      const sh3Codes = this.sh3Codes as [Uint32Array, Uint32Array] | undefined;
      const result = (await worker.call("loadExtSplats", {
        fileBytes: decodeBytes,
        pathName: this.chunkUrl(chunk),
        sh1Codes: this.sh1Codes?.slice(),
        sh2Codes: this.sh2Codes?.slice(),
        sh3Codes: sh3Codes
          ? [sh3Codes[0].slice(), sh3Codes[1].slice()]
          : undefined,
      })) as { lodSplats: ExtResult };
      const lodSplats = result.lodSplats;
      if (!this.splatEncoding) {
        this.splatEncoding = DEFAULT_SPLAT_ENCODING;
        this.numSh =
          lodSplats.extra.sh3a && lodSplats.extra.sh3b
            ? 3
            : lodSplats.extra.sh2
              ? 2
              : lodSplats.extra.sh1
                ? 1
                : 0;
      }
      this.sh1Codes = lodSplats.extra.sh1Codes ?? this.sh1Codes;
      this.sh2Codes = lodSplats.extra.sh2Codes ?? this.sh2Codes;
      this.sh3Codes = lodSplats.extra.sh3Codes ?? this.sh3Codes;
      emitExperimentEvent("parse_complete", {
        object_id: chunkObjectId,
        chunk,
        num_splats: lodSplats.numSplats ?? 0,
        parse_complete_ts_ms: Date.now(),
      });
      return lodSplats;
    });
  }

  update(numSplats: number, indices: Uint32Array) {
    if (!this.pager) {
      throw new Error("PagedSplats.pager not set");
    }

    const renderer = this.pager.renderer;
    this.numSplats = numSplats;
    this.dynoNumSplats.value = this.numSplats;
    const rows = Math.ceil(numSplats / 16384);

    let indicesTexture =
      this.dynoIndices.value === SplatPager.emptyIndicesTexture
        ? undefined
        : this.dynoIndices.value;
    if (indicesTexture && rows > indicesTexture.image.height) {
      indicesTexture.dispose();
      indicesTexture = undefined;
    }

    if (!indicesTexture) {
      indicesTexture = new THREE.DataTexture(
        indices,
        4096,
        rows,
        THREE.RGBAIntegerFormat,
        THREE.UnsignedIntType,
      );
      indicesTexture.internalFormat = "RGBA32UI";
      indicesTexture.needsUpdate = true;
      renderer.initTexture(indicesTexture);
      this.dynoIndices.value = indicesTexture;
    } else {
      const textureIndices = indicesTexture.image.data as Uint32Array;
      textureIndices.set(indices.subarray(0, numSplats));

      const gl = renderer.getContext() as WebGL2RenderingContext;
      renderer.state.activeTexture(gl.TEXTURE0);
      renderer.state.bindTexture(
        gl.TEXTURE_2D,
        getGlTexture(renderer, indicesTexture),
      );
      gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        4096,
        rows,
        gl.RGBA_INTEGER,
        gl.UNSIGNED_INT,
        indices,
      );
      renderer.state.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  prepareFetchSplat() {}

  getNumSplats(): number {
    return this.numSplats;
  }

  hasRgbDir(): boolean {
    if (!this.pager) {
      return false;
    }
    return Math.min(this.numSh, this.pager.maxSh) > 0;
  }

  getNumSh(): number {
    return this.numSh;
  }

  fetchSplat({
    index,
    viewOrigin,
  }: {
    index: dyno.DynoVal<"int">;
    viewOrigin?: dyno.DynoVal<"vec3">;
  }): dyno.DynoVal<typeof dyno.Gsplat> {
    if (!this.pager) {
      throw new Error("PagedSplats.pager not set");
    }

    const splatIndex = this.pager.readIndex.apply({
      index,
      numSplats: this.dynoNumSplats,
      indices: this.dynoIndices,
    }).index;

    if (!this.pager.extSplats) {
      if (this.hasRgbDir() && viewOrigin) {
        this.dynoNumSh.value = Math.min(
          this.numSh,
          this.maxSh,
          this.pager.maxSh,
        );
        return this.pager.readSplatDir.apply({
          index: splatIndex,
          rgbMinMaxLnScaleMinMax: this.rgbMinMaxLnScaleMinMax,
          lodOpacity: this.lodOpacity,
          viewOrigin,
          numSh: this.dynoNumSh,
          shMax: this.shMax,
        }).gsplat;
      }
      return this.pager.readSplat.apply({
        index: splatIndex,
        rgbMinMaxLnScaleMinMax: this.rgbMinMaxLnScaleMinMax,
        lodOpacity: this.lodOpacity,
      }).gsplat;
    }

    if (this.hasRgbDir() && viewOrigin) {
      this.dynoNumSh.value = Math.min(this.numSh, this.maxSh, this.pager.maxSh);
      return this.pager.readSplatExtDir.apply({
        index: splatIndex,
        viewOrigin,
        numSh: this.dynoNumSh,
      }).gsplat;
    }
    return this.pager.readSplatExt.apply({ index: splatIndex }).gsplat;
  }
}

export interface SplatPagerOptions {
  /**
   * THREE.WebGLRenderer instance to upload texture data
   */
  renderer: THREE.WebGLRenderer;
  /**
   * Whether to use extended Gsplat encoding for paged splats.
   * @default false
   */
  extSplats?: boolean;
  /**
   * Maximum size of splat page pool
   * @default 65536 * 256 = 16777216
   */
  maxSplats?: number;
  /**
   * Maximum number of spherical harmonics to keep
   * @default 3
   */
  maxSh?: number;
  /**
   * Automatically drive page fetching, or poll via drive()
   * @default true
   */
  autoDrive?: boolean;
  /**
   * Number of parallel chunk fetchers
   * @default 3
   */
  numFetchers?: number;
}

export class SplatPager {
  renderer: THREE.WebGLRenderer;

  extSplats: boolean;
  maxPages: number;
  maxSplats: number;
  pageSplats: number;

  maxSh: number;
  curSh: number;

  autoDrive: boolean;
  numFetchers: number;
  fetchPause = 0;

  splatsChunkToPage: Map<
    PagedSplats,
    ({ page: number; lru: number } | undefined)[]
  > = new Map();
  pageToSplatsChunk: (
    | { splats: PagedSplats; chunk: number; time: number }
    | undefined
  )[] = [];
  pageFreelist: number[];
  pageLru: Set<{ page: number; lru: number }>;
  freeablePages: number[];
  newUploads: {
    page: number;
    numSplats: number;
    packedArray: Uint32Array;
    extArray?: Uint32Array;
    extra: Record<string, unknown>;
  }[];
  readyUploads: {
    page: number;
    numSplats: number;
    packedArray: Uint32Array;
    extArray?: Uint32Array;
    extra: Record<string, unknown>;
  }[];
  lodTreeUpdates: {
    splats: PagedSplats;
    page: number;
    chunk: number;
    numSplats: number;
    lodTree?: Uint32Array;
  }[];

  fetchers: { splats: PagedSplats; chunk: number; promise: Promise<void> }[];
  fetched: {
    splats: PagedSplats;
    chunk: number;
    data: PackedResult | ExtResult;
  }[];
  fetchPriority: { splats: PagedSplats; chunk: number }[];

  packedTexture: dyno.DynoUsampler2DArray<
    "packedTexture",
    THREE.DataArrayTexture
  >;
  extTexture: dyno.DynoUsampler2DArray<"extTexture", THREE.DataArrayTexture>;

  sh1Texture: dyno.DynoUsampler2DArray<"sh1", THREE.DataArrayTexture>;
  sh2Texture: dyno.DynoUsampler2DArray<"sh2", THREE.DataArrayTexture>;
  sh3Texture: dyno.DynoUsampler2DArray<"sh3", THREE.DataArrayTexture>;
  sh3TextureB: dyno.DynoUsampler2DArray<"sh3b", THREE.DataArrayTexture>;

  readIndex: dyno.DynoBlock<
    { index: "int"; numSplats: "int"; indices: "usampler2D" },
    { index: "int" }
  >;
  readSplat: dyno.DynoBlock<
    { index: "int"; rgbMinMaxLnScaleMinMax: "vec4"; lodOpacity: "bool" },
    { gsplat: typeof dyno.Gsplat }
  >;
  readSplatExt: dyno.DynoBlock<
    { index: "int" },
    { gsplat: typeof dyno.Gsplat }
  >;
  readSplatDir: dyno.DynoBlock<
    {
      index: "int";
      rgbMinMaxLnScaleMinMax: "vec4";
      lodOpacity: "bool";
      viewOrigin: "vec3";
      numSh: "int";
      shMax: "vec3";
    },
    { gsplat: typeof dyno.Gsplat }
  >;
  readSplatExtDir: dyno.DynoBlock<
    { index: "int"; viewOrigin: "vec3"; numSh: "int" },
    { gsplat: typeof dyno.Gsplat }
  >;

  constructor(options: SplatPagerOptions) {
    this.renderer = options.renderer;
    this.extSplats = options.extSplats ?? false;

    this.pageSplats = 65536;
    this.maxSplats = options.maxSplats ?? 16777216;
    this.maxPages = Math.ceil(this.maxSplats / this.pageSplats);
    this.maxSplats = this.maxPages * this.pageSplats;

    this.maxSh = options.maxSh ?? 3;
    this.curSh = 0;

    this.autoDrive = options.autoDrive ?? true;
    this.numFetchers = options.numFetchers ?? 3;

    this.splatsChunkToPage = new Map();
    this.pageToSplatsChunk = new Array(this.maxPages);
    this.pageFreelist = Array.from({ length: this.maxPages }, (_, i) => i);
    this.pageLru = new Set();
    this.freeablePages = [];
    this.newUploads = [];
    this.readyUploads = [];
    this.lodTreeUpdates = [];

    this.fetchers = [];
    this.fetched = [];
    this.fetchPriority = [];

    this.packedTexture = new dyno.DynoUsampler2DArray({
      value: this.newUint32ArrayTexture(
        new Uint32Array(this.maxPages * 256 * 256 * 4),
        256,
        256,
        this.maxPages,
        THREE.RGBAIntegerFormat,
        THREE.UnsignedIntType,
        "RGBA32UI",
      ),
    });
    this.extTexture = new dyno.DynoUsampler2DArray({
      value: this.extSplats
        ? this.newUint32ArrayTexture(
            new Uint32Array(this.maxPages * 256 * 256 * 4),
            256,
            256,
            this.maxPages,
            THREE.RGBAIntegerFormat,
            THREE.UnsignedIntType,
            "RGBA32UI",
          )
        : SplatPager.emptyExtTexture,
    });
    this.sh1Texture = new dyno.DynoUsampler2DArray({
      value: this.extSplats
        ? SplatPager.emptyExtSh1Texture
        : SplatPager.emptySh1Texture,
    });
    this.sh2Texture = new dyno.DynoUsampler2DArray({
      value: this.extSplats
        ? SplatPager.emptyExtSh2Texture
        : SplatPager.emptySh2Texture,
    });
    this.sh3Texture = new dyno.DynoUsampler2DArray({
      value: this.extSplats
        ? SplatPager.emptyExtSh3Texture
        : SplatPager.emptySh3Texture,
    });
    this.sh3TextureB = new dyno.DynoUsampler2DArray({
      value: SplatPager.emptyExtSh3BTexture,
    });

    this.readIndex = dyno.dynoBlock(
      { index: "int", numSplats: "int", indices: "usampler2D" },
      { index: "int" },
      ({ index, numSplats, indices }) => {
        return new dyno.Dyno({
          inTypes: {
            index: "int",
            numSplats: "int",
            indices: "usampler2D",
          },
          outTypes: { index: "int" },
          inputs: {
            index,
            numSplats,
            indices,
          },
          statements: ({ inputs, outputs }) =>
            dyno.unindentLines(`
            if (${inputs.index} >= ${inputs.numSplats}) {
              return;
            }

            ivec2 indexCoord = ivec2((${inputs.index} >> 2) & 4095, ${inputs.index} >> 14);
            uint index = texelFetch(${inputs.indices}, indexCoord, 0)[${inputs.index} & 3];
            ${outputs.index} = int(index);
          `),
        }).outputs;
      },
    );

    this.readSplat = dyno.dynoBlock(
      { index: "int", rgbMinMaxLnScaleMinMax: "vec4", lodOpacity: "bool" },
      { gsplat: dyno.Gsplat },
      ({ index, rgbMinMaxLnScaleMinMax, lodOpacity }) => {
        return new dyno.Dyno({
          inTypes: {
            index: "int",
            packedTexture: "usampler2DArray",
            rgbMinMaxLnScaleMinMax: "vec4",
            lodOpacity: "bool",
          },
          outTypes: { gsplat: dyno.Gsplat },
          inputs: {
            index,
            packedTexture: this.packedTexture,
            rgbMinMaxLnScaleMinMax,
            lodOpacity,
          },
          globals: () => [dyno.defineGsplat],
          statements: ({ inputs, outputs }) =>
            dyno.unindentLines(`
            int index = ${inputs.index};
            ivec3 splatCoord = pagedSplatTexCoord(index);
            uvec4 packed = texelFetch(${inputs.packedTexture}, splatCoord, 0);

            unpackSplatEncoding(packed, ${outputs.gsplat}.center, ${outputs.gsplat}.scales, ${outputs.gsplat}.quaternion, ${outputs.gsplat}.rgba, ${inputs.rgbMinMaxLnScaleMinMax});
            if ((${outputs.gsplat}.rgba.a == 0.0) || all(equal(${outputs.gsplat}.scales, vec3(0.0, 0.0, 0.0)))) {
              return;
            }
            
            ${outputs.gsplat}.index = index;
            ${outputs.gsplat}.flags = GSPLAT_FLAG_ACTIVE;
            if (${inputs.lodOpacity}) {
              ${outputs.gsplat}.rgba.a *= 2.0;
            }
          `),
        }).outputs;
      },
    );

    this.readSplatDir = dyno.dynoBlock(
      {
        index: "int",
        rgbMinMaxLnScaleMinMax: "vec4",
        lodOpacity: "bool",
        viewOrigin: "vec3",
        numSh: "int",
        shMax: "vec3",
      },
      { gsplat: dyno.Gsplat },
      ({
        index,
        rgbMinMaxLnScaleMinMax,
        lodOpacity,
        viewOrigin,
        numSh,
        shMax,
      }) => {
        if (
          !index ||
          !rgbMinMaxLnScaleMinMax ||
          !lodOpacity ||
          !viewOrigin ||
          !numSh ||
          !shMax
        ) {
          throw new Error("index and viewOrigin are required");
        }
        let gsplat = this.readSplat.apply({
          index,
          rgbMinMaxLnScaleMinMax,
          lodOpacity,
        }).gsplat;

        const splatCenter = dyno.splitGsplat(gsplat).outputs.center;
        const viewDir = dyno.normalize(dyno.sub(splatCenter, viewOrigin));
        let rgb = evaluatePackedSH({
          coord: pagedSplatTexCoord(index),
          viewDir,
          numSh,
          sh1Texture: this.sh1Texture,
          sh2Texture: this.sh2Texture,
          sh3Texture: this.sh3Texture,
          shMax,
        }).rgb;
        rgb = dyno.add(rgb, dyno.splitGsplat(gsplat).outputs.rgb);
        gsplat = dyno.combineGsplat({ gsplat, rgb });
        return { gsplat };
      },
    );

    this.readSplatExt = dyno.dynoBlock(
      { index: "int" },
      { gsplat: dyno.Gsplat },
      ({ index }) => {
        return new dyno.Dyno({
          inTypes: {
            index: "int",
            extTexture1: "usampler2DArray",
            extTexture2: "usampler2DArray",
          },
          outTypes: { gsplat: dyno.Gsplat },
          inputs: {
            index,
            extTexture1: this.packedTexture,
            extTexture2: this.extTexture,
          },
          globals: () => [dyno.defineGsplat],
          statements: ({ inputs, outputs }) =>
            dyno.unindentLines(`
            int index = ${inputs.index};
            ivec3 splatCoord = ivec3(index & 255, (index >> 8) & 255, index >> 16);
            uvec4 ext1 = texelFetch(${inputs.extTexture1}, splatCoord, 0);
            float alpha = unpackSplatExtAlpha(ext1);
            if (alpha == 0.0) {
              return;
            }

            uvec4 ext2 = texelFetch(${inputs.extTexture2}, splatCoord, 0);
            unpackSplatExt(ext1, ext2, ${outputs.gsplat}.center, ${outputs.gsplat}.scales, ${outputs.gsplat}.quaternion, ${outputs.gsplat}.rgba);
            if (all(equal(${outputs.gsplat}.scales, vec3(0.0, 0.0, 0.0)))) {
              return;
            }

            ${outputs.gsplat}.index = index;
            ${outputs.gsplat}.flags = GSPLAT_FLAG_ACTIVE;
          `),
        }).outputs;
      },
    );

    this.readSplatExtDir = dyno.dynoBlock(
      {
        index: "int",
        viewOrigin: "vec3",
        numSh: "int",
      },
      { gsplat: dyno.Gsplat },
      ({ index, viewOrigin, numSh }) => {
        if (!index || !viewOrigin || !numSh) {
          throw new Error("index and viewOrigin are required");
        }
        let gsplat = this.readSplatExt.apply({ index }).gsplat;

        const splatCenter = dyno.splitGsplat(gsplat).outputs.center;
        const viewDir = dyno.normalize(dyno.sub(splatCenter, viewOrigin));
        let rgb = evaluateExtSH({
          coord: pagedSplatTexCoord(index),
          viewDir,
          numSh,
          sh1Texture: this.sh1Texture,
          sh2Texture: this.sh2Texture,
          sh3TextureA: this.sh3Texture,
          sh3TextureB: this.sh3TextureB,
        }).rgb;
        rgb = dyno.add(rgb, dyno.splitGsplat(gsplat).outputs.rgb);
        gsplat = dyno.combineGsplat({ gsplat, rgb });
        return { gsplat };
      },
    );
  }

  dispose() {
    this.autoDrive = false;
    this.numFetchers = 0;

    this.packedTexture.value.dispose();
    if (this.extTexture.value !== SplatPager.emptyExtTexture) {
      this.extTexture.value.dispose();
    }

    if (!this.extSplats) {
      if (this.sh1Texture.value !== SplatPager.emptySh1Texture) {
        this.sh1Texture.value.dispose();
      }
      if (this.sh2Texture.value !== SplatPager.emptySh2Texture) {
        this.sh2Texture.value.dispose();
      }
      if (this.sh3Texture.value !== SplatPager.emptySh3Texture) {
        this.sh3Texture.value.dispose();
      }
    } else {
      if (this.sh1Texture.value !== SplatPager.emptyExtSh1Texture) {
        this.sh1Texture.value.dispose();
      }
      if (this.sh2Texture.value !== SplatPager.emptyExtSh2Texture) {
        this.sh2Texture.value.dispose();
      }
      if (this.sh3Texture.value !== SplatPager.emptyExtSh3Texture) {
        this.sh3Texture.value.dispose();
      }
      if (this.sh3TextureB.value !== SplatPager.emptyExtSh3BTexture) {
        this.sh3TextureB.value.dispose();
      }
    }
  }

  private ensureShTextures(numSh: number) {
    this.curSh = Math.max(this.curSh, numSh);
    if (!this.extSplats) {
      if (
        this.curSh >= 1 &&
        this.sh1Texture.value === SplatPager.emptySh1Texture
      ) {
        this.sh1Texture.value = this.newUint32ArrayTexture(
          new Uint32Array(this.maxPages * 256 * 256 * 2),
          256,
          256,
          this.maxPages,
          THREE.RGIntegerFormat,
          THREE.UnsignedIntType,
          "RG32UI",
        );
      }
    } else {
      if (
        this.curSh >= 1 &&
        this.sh1Texture.value === SplatPager.emptyExtSh1Texture
      ) {
        this.sh1Texture.value = this.newUint32ArrayTexture(
          new Uint32Array(this.maxPages * 256 * 256 * 4),
          256,
          256,
          this.maxPages,
          THREE.RGBAIntegerFormat,
          THREE.UnsignedIntType,
          "RGBA32UI",
        );
      }
    }
    if (
      this.curSh >= 2 &&
      this.sh2Texture.value ===
        (!this.extSplats
          ? SplatPager.emptySh2Texture
          : SplatPager.emptyExtSh2Texture)
    ) {
      this.sh2Texture.value = this.newUint32ArrayTexture(
        new Uint32Array(this.maxPages * 256 * 256 * 4),
        256,
        256,
        this.maxPages,
        THREE.RGBAIntegerFormat,
        THREE.UnsignedIntType,
        "RGBA32UI",
      );
    }
    if (!this.extSplats) {
      if (
        this.curSh >= 3 &&
        this.sh3Texture.value === SplatPager.emptySh3Texture
      ) {
        this.sh3Texture.value = this.newUint32ArrayTexture(
          new Uint32Array(this.maxPages * 256 * 256 * 4),
          256,
          256,
          this.maxPages,
          THREE.RGBAIntegerFormat,
          THREE.UnsignedIntType,
          "RGBA32UI",
        );
      }
    } else {
      if (this.curSh >= 3) {
        if (this.sh3Texture.value === SplatPager.emptyExtSh3Texture) {
          this.sh3Texture.value = this.newUint32ArrayTexture(
            new Uint32Array(this.maxPages * 256 * 256 * 4),
            256,
            256,
            this.maxPages,
            THREE.RGBAIntegerFormat,
            THREE.UnsignedIntType,
            "RGBA32UI",
          );
        }
        if (this.sh3TextureB.value === SplatPager.emptyExtSh3BTexture) {
          this.sh3TextureB.value = this.newUint32ArrayTexture(
            new Uint32Array(this.maxPages * 256 * 256 * 4),
            256,
            256,
            this.maxPages,
            THREE.RGBAIntegerFormat,
            THREE.UnsignedIntType,
            "RGBA32UI",
          );
        }
      }
    }
  }

  private allocatePage(): number | undefined {
    return this.pageFreelist.shift();
  }

  private freePage(page: number) {
    this.pageFreelist.push(page);
  }

  getSplatsChunk(splats: PagedSplats, chunk: number) {
    const chunks = this.splatsChunkToPage.get(splats);
    if (!chunks) {
      return undefined;
    }
    return chunks[chunk];
  }

  private insertSplatsChunkPage(
    splats: PagedSplats,
    chunk: number,
    page: number,
    now: number,
  ) {
    if (!this.splatsChunkToPage.has(splats)) {
      this.splatsChunkToPage.set(splats, []);
    }
    const chunks = this.splatsChunkToPage.get(splats);
    if (!chunks) {
      throw new Error("impossible");
    }
    if (chunk >= chunks.length) {
      chunks.length = chunk + 1;
    }
    const pageLru = { page, lru: now };
    chunks[chunk] = pageLru;
    this.pageLru.add(pageLru);

    this.pageToSplatsChunk[page] = { splats, chunk, time: performance.now() };
    return this.pageToSplatsChunk[page];
  }

  private removeSplatsChunkPage(
    splats: PagedSplats,
    chunk: number,
    page: number,
  ) {
    const chunks = this.splatsChunkToPage.get(splats);
    if (!chunks) {
      throw new Error("impossible");
    }

    const pageLru = chunks[chunk];
    if (!pageLru) {
      throw new Error(
        `pageLru not found for splats: ${splats}, chunk: ${chunk}, page: ${page}`,
      );
    }
    this.pageLru.delete(pageLru);

    chunks[chunk] = undefined;

    while (chunks.length > 0 && chunks[chunks.length - 1] === undefined) {
      chunks.pop();
    }
    if (chunks.length === 0) {
      this.splatsChunkToPage.delete(splats);
    }

    this.pageToSplatsChunk[page] = undefined;
    while (
      this.pageToSplatsChunk.length > 0 &&
      this.pageToSplatsChunk[this.pageToSplatsChunk.length - 1] === undefined
    ) {
      this.pageToSplatsChunk.pop();
    }
  }

  private uploadPage(
    page: number,
    packedArray: Uint32Array,
    extra: Record<string, unknown>,
    extArray?: Uint32Array,
  ) {
    const pageBase = page * this.pageSplats;
    emitExperimentEvent("upload_start", {
      page,
      upload_start_ts_ms: Date.now(),
    });

    // const gl = this.renderer.getContext() as WebGL2RenderingContext;

    // this.renderer.state.activeTexture(gl.TEXTURE0);
    // this.renderer.state.bindTexture(
    //   gl.TEXTURE_2D_ARRAY,
    //   this.getGlTexture(this.packedTexture.value),
    // );
    // gl.texSubImage3D(
    //   gl.TEXTURE_2D_ARRAY,
    //   0,
    //   0,
    //   0,
    //   page,
    //   256,
    //   256,
    //   1,
    //   gl.RGBA_INTEGER,
    //   gl.UNSIGNED_INT,
    //   packedArray,
    // );

    const array = this.packedTexture.value.image.data;
    array
      .subarray(pageBase * 4, pageBase * 4 + packedArray.length)
      .set(packedArray);
    this.packedTexture.value.addLayerUpdate(page);
    this.packedTexture.value.needsUpdate = true;

    if (extArray) {
      const array = this.extTexture.value.image.data;
      array
        .subarray(pageBase * 4, pageBase * 4 + extArray.length)
        .set(extArray);
      this.extTexture.value.addLayerUpdate(page);
      this.extTexture.value.needsUpdate = true;
    }

    const numSh = this.extSplats
      ? extra.sh3a && extra.sh3b
        ? 3
        : extra.sh2
          ? 2
          : extra.sh1
            ? 1
            : 0
      : extra.sh3
        ? 3
        : extra.sh2
          ? 2
          : extra.sh1
            ? 1
            : 0;
    this.ensureShTextures(numSh);

    if (!this.extSplats) {
      if (this.sh1Texture.value !== SplatPager.emptySh1Texture && extra.sh1) {
        // this.renderer.state.bindTexture(
        //   gl.TEXTURE_2D_ARRAY,
        //   this.getGlTexture(this.sh1Texture.value),
        // );
        // gl.texSubImage3D(
        //   gl.TEXTURE_2D_ARRAY,
        //   0,
        //   0,
        //   0,
        //   page,
        //   256,
        //   256,
        //   1,
        //   gl.RG_INTEGER,
        //   gl.UNSIGNED_INT,
        //   extra.sh1 as Uint32Array<ArrayBuffer>,
        // );
        const sh1 = extra.sh1 as Uint32Array<ArrayBuffer>;
        const array = this.sh1Texture.value.image.data;
        array.subarray(pageBase * 2, pageBase * 2 + sh1.length).set(sh1);
        this.sh1Texture.value.addLayerUpdate(page);
        this.sh1Texture.value.needsUpdate = true;
      }
    } else {
      if (
        this.sh1Texture.value !== SplatPager.emptyExtSh1Texture &&
        extra.sh1
      ) {
        const sh1 = extra.sh1 as Uint32Array<ArrayBuffer>;
        const array = this.sh1Texture.value.image.data;
        array.subarray(pageBase * 4, pageBase * 4 + sh1.length).set(sh1);
        this.sh1Texture.value.addLayerUpdate(page);
        this.sh1Texture.value.needsUpdate = true;
      }
    }

    if (this.sh2Texture.value !== SplatPager.emptySh2Texture && extra.sh2) {
      // this.renderer.state.bindTexture(
      //   gl.TEXTURE_2D_ARRAY,
      //   this.getGlTexture(this.sh2Texture.value),
      // );
      // gl.texSubImage3D(
      //   gl.TEXTURE_2D_ARRAY,
      //   0,
      //   0,
      //   0,
      //   page,
      //   256,
      //   256,
      //   1,
      //   gl.RGBA_INTEGER,
      //   gl.UNSIGNED_INT,
      //   extra.sh2 as Uint32Array<ArrayBuffer>,
      // );
      const sh2 = extra.sh2 as Uint32Array<ArrayBuffer>;
      const array = this.sh2Texture.value.image.data;
      array.subarray(pageBase * 4, pageBase * 4 + sh2.length).set(sh2);
      this.sh2Texture.value.addLayerUpdate(page);
      this.sh2Texture.value.needsUpdate = true;
    }

    if (!this.extSplats) {
      if (this.sh3Texture.value !== SplatPager.emptySh3Texture && extra.sh3) {
        // this.renderer.state.bindTexture(
        //   gl.TEXTURE_2D_ARRAY,
        //   this.getGlTexture(this.sh3Texture.value),
        // );
        // gl.texSubImage3D(
        //   gl.TEXTURE_2D_ARRAY,
        //   0,
        //   0,
        //   0,
        //   page,
        //   256,
        //   256,
        //   1,
        //   gl.RGBA_INTEGER,
        //   gl.UNSIGNED_INT,
        //   extra.sh3 as Uint32Array<ArrayBuffer>,
        // );
        const sh3 = extra.sh3 as Uint32Array<ArrayBuffer>;
        const array = this.sh3Texture.value.image.data;
        array.subarray(pageBase * 4, pageBase * 4 + sh3.length).set(sh3);
        this.sh3Texture.value.addLayerUpdate(page);
        this.sh3Texture.value.needsUpdate = true;
      }
    } else {
      if (
        this.sh3Texture.value !== SplatPager.emptyExtSh3Texture &&
        extra.sh3a
      ) {
        const sh3a = extra.sh3a as Uint32Array<ArrayBuffer>;
        const array = this.sh3Texture.value.image.data;
        array.subarray(pageBase * 4, pageBase * 4 + sh3a.length).set(sh3a);
        this.sh3Texture.value.addLayerUpdate(page);
        this.sh3Texture.value.needsUpdate = true;
      }
      if (
        this.sh3TextureB.value !== SplatPager.emptyExtSh3BTexture &&
        extra.sh3b
      ) {
        const sh3b = extra.sh3b as Uint32Array<ArrayBuffer>;
        const array = this.sh3TextureB.value.image.data;
        array.subarray(pageBase * 4, pageBase * 4 + sh3b.length).set(sh3b);
        this.sh3TextureB.value.addLayerUpdate(page);
        this.sh3TextureB.value.needsUpdate = true;
      }
    }

    // this.renderer.state.bindTexture(gl.TEXTURE_2D_ARRAY, null);
    emitExperimentEvent("upload_complete", {
      page,
      upload_complete_ts_ms: Date.now(),
    });
  }

  private getGlTexture(texture: THREE.Texture): WebGLTexture {
    return getGlTexture(this.renderer, texture);
  }

  private newUint32ArrayTexture(
    data: Uint32Array<ArrayBuffer> | null,
    width: number,
    height: number,
    depth: number,
    format: THREE.AnyPixelFormat,
    type: THREE.TextureDataType,
    internalFormat: THREE.PixelFormatGPU,
  ): THREE.DataArrayTexture {
    const texture = new THREE.DataArrayTexture(data, width, height, depth);
    texture.format = format;
    texture.type = type;
    texture.internalFormat = internalFormat;
    texture.needsUpdate = true;
    this.renderer.initTexture(texture);
    return texture;
  }

  driveFetchers() {
    const needed = [];
    const overflow = [];
    let numPages = 0;

    // DLS: Demand Lookahead Scheduling (gated variant)
    // Only issue lookahead when the pipeline is underutilized:
    //   1. Normal demand has absolute priority (lookahead appended AFTER all demands)
    //   2. Lookahead only dispatched if fetcher slots remain after all normal demands are served
    //   3. Gate: if fetchPriority already has >= numFetchers entries, skip lookahead entirely
    //      (pipeline is already full from normal demand — no idle window to fill)
    const sdlK = (window as Window & { __sparkSdlK?: number }).__sparkSdlK ?? 0;
    const sdlStats = ((window as Window & { __sdlStats?: {
      lookahead_enqueued: number;
      lookahead_confirmed: number;
      lookahead_wasted: number;
      lookahead_gated_off: number;
      original_demanded: number;
      drive_calls: number;
    } }).__sdlStats ??= {
      lookahead_enqueued: 0,
      lookahead_confirmed: 0,
      lookahead_wasted: 0,
      lookahead_gated_off: 0,
      original_demanded: 0,
      drive_calls: 0,
    });

    sdlStats.drive_calls += 1;

    if (sdlK > 0) {
      // Gate check: only add lookahead if pipeline has room.
      // If normal demand already fills all fetcher slots, lookahead would just
      // queue behind them and block future normal demands from getting slots.
      const normalDemandCount = this.fetchPriority.length;
      const activeFetchers = this.fetchers.length;
      const availableSlots = this.numFetchers - activeFetchers;
      // Strict gate: only add lookahead when ALL fetcher slots are idle AND
      // no normal demand is pending. This guarantees lookahead never competes
      // with normal demand for fetcher slots — it only fills true idle windows.
      const pipelineIdle = activeFetchers === 0 && normalDemandCount === 0;

      if (!pipelineIdle) {
        sdlStats.lookahead_gated_off += 1;
      } else {
        // Pipeline has idle capacity — add lookahead to fill it
        const existingChunks = new Set(
          this.fetchPriority.map(({ splats, chunk }) => `${splats.rootUrl}#${chunk}`),
        );
        const newEntries: { splats: PagedSplats; chunk: number }[] = [];
        // Limit total lookahead to available slots (never exceed pipeline capacity)
        const maxLookahead = Math.max(0, availableSlots - normalDemandCount);
        let lookaheadAdded = 0;

        for (const { splats, chunk } of this.fetchPriority) {
          if (lookaheadAdded >= maxLookahead) break;
          sdlStats.original_demanded += 1;
          const radMeta = (splats as PagedSplats & { _cachedRadMeta?: { chunks: { offset: number; bytes: number }[] } })._cachedRadMeta;
          const maxChunk = radMeta?.chunks?.length ?? 999;

          for (let k = 1; k <= sdlK && lookaheadAdded < maxLookahead; k++) {
            const lookaheadChunk = chunk + k;
            if (lookaheadChunk >= maxChunk) break;
            const key = `${splats.rootUrl}#${lookaheadChunk}`;
            if (existingChunks.has(key)) continue;
            if (this.getSplatsChunk(splats, lookaheadChunk)) continue;
            if (this.fetched.some(({ splats: s, chunk: c }) => splats === s && c === lookaheadChunk)) continue;
            if (this.fetchers.some(({ splats: s, chunk: c }) => splats === s && c === lookaheadChunk)) continue;

            existingChunks.add(key);
            newEntries.push({ splats, chunk: lookaheadChunk });
            sdlStats.lookahead_enqueued += 1;
            lookaheadAdded += 1;
          }
        }

        // Append lookahead AFTER all normal demands (lower priority)
        this.fetchPriority.push(...newEntries);
      }
    }

    for (let priorityIndex = 0; priorityIndex < this.fetchPriority.length; priorityIndex += 1) {
      const { splats, chunk } = this.fetchPriority[priorityIndex];
      const objectId = `${splats.rootUrl || "unknown"}#chunk-${chunk}`;
      emitExperimentEvent("scheduler_decision", {
        object_id: objectId,
        object_url: splats.chunkUrl(chunk),
        chunk,
        priority: this.fetchPriority.length - priorityIndex,
        utility_score:
          this.fetchPriority.length > 1
            ? (this.fetchPriority.length - priorityIndex) / this.fetchPriority.length
            : 1,
        visibility_flag: true,
        scheduler_reason: "lod_fetch_priority_queue",
      });
      const pageLru = this.getSplatsChunk(splats, chunk);
      if (pageLru) {
        if (numPages >= this.maxPages) {
          overflow.push(pageLru);
        } else {
          needed.push(pageLru);
        }
        numPages += 1;
        continue;
      }

      if (
        this.fetched.some(
          ({ splats: s, chunk: c }) => splats === s && chunk === c,
        ) ||
        this.fetchers.some(
          ({ splats: s, chunk: c }) => splats === s && chunk === c,
        )
      ) {
        numPages += 1;
        continue;
      }

      if (numPages < this.maxPages && this.fetchers.length < this.numFetchers) {
        numPages += 1;
        emitExperimentEvent("fetch_enqueue", {
          object_id: objectId,
          object_url: splats.chunkUrl(chunk),
          chunk,
          enqueue_ts_ms: Date.now(),
        });
        const promise = splats
          .fetchDecodeChunk(chunk)
          .then(
            async (data) => {
              emitExperimentEvent("fetch_response", {
                object_id: objectId,
                object_url: splats.chunkUrl(chunk),
                chunk,
                num_splats: data.numSplats,
                response_ts_ms: Date.now(),
              });
              // Place data in ready queue and remove self from active fetchers list
              this.fetched.push({ splats, chunk, data });
              if (this.fetchPause > 0) {
                await new Promise((resolve) =>
                  setTimeout(resolve, this.fetchPause),
                );
              }
            },
            async (error) => {
              console.warn(error);
              const backoff = 250 + 500 * Math.random();
              await new Promise((resolve) => setTimeout(resolve, backoff));
            },
          )
          .finally(() => {
            this.fetchers = this.fetchers.filter(
              ({ splats: s, chunk: c }) => splats !== s || chunk !== c,
            );
            this.processFetched();
          });
        // Add self to active fetchers list
        this.fetchers.push({ splats, chunk, promise });

        promise.then((data) => {
          if (this.autoDrive) {
            this.driveFetchers();
          }
        });
      }
    }

    // Update LRU ordering in reverse priority order
    const now = performance.now();

    for (const pageLru of overflow.reverse()) {
      pageLru.lru = now;
      this.pageLru.delete(pageLru);
      this.pageLru.add(pageLru);
    }

    // Create set of pages not needed
    const extraPages = new Set(this.pageLru);
    for (const pageLru of needed.reverse()) {
      extraPages.delete(pageLru);

      pageLru.lru = now;
      this.pageLru.delete(pageLru);
      this.pageLru.add(pageLru);
    }
    this.freeablePages = Array.from(extraPages).map(({ page }) => page);
  }

  private allocateFreeable(): number | undefined {
    const page = this.freeablePages.shift();
    if (page === undefined) {
      // No freeable pages available
      return undefined;
    }

    const splatsChunk = this.pageToSplatsChunk[page];
    if (!splatsChunk) {
      throw new Error(`splatsChunk not found for page: ${page}`);
    }

    const { splats, chunk } = splatsChunk;
    this.removeSplatsChunkPage(splats, chunk, page);
    this.lodTreeUpdates.push({
      splats,
      page,
      chunk,
      numSplats: this.pageSplats,
    });
    return page;
  }

  private processFetched() {
    const now = performance.now();
    while (true) {
      const fetched = this.fetched.shift();
      if (!fetched) {
        break;
      }
      const { splats, chunk, data } = fetched;

      let page = this.allocatePage();
      if (page === undefined) {
        page = this.allocateFreeable();
        if (page === undefined) {
          // No pages available, stop for now
          return;
        }
      }

      this.insertSplatsChunkPage(splats, chunk, page, now);
      const { numSplats, extra } = data;
      this.lodTreeUpdates.push({
        splats,
        page,
        chunk,
        numSplats,
        lodTree: extra.lodTree as Uint32Array,
      });

      if (!this.extSplats) {
        const packedArray = (data as PackedResult).packedArray;
        this.newUploads.push({ page, numSplats, packedArray, extra });
      } else {
        const extArrays = (data as ExtResult).extArrays;
        const packedArray = extArrays[0];
        const extArray = extArrays[1];
        this.newUploads.push({ page, numSplats, packedArray, extArray, extra });
      }
    }
  }

  processUploads() {
    while (true) {
      const upload = this.readyUploads.shift();
      if (!upload) {
        break;
      }
      const { page, numSplats, packedArray, extArray, extra } = upload;
      this.uploadPage(page, packedArray, extra, extArray);
    }
  }

  consumeLodTreeUpdates() {
    const updates = this.lodTreeUpdates;
    this.lodTreeUpdates = [];

    this.readyUploads.push(...this.newUploads);
    this.newUploads = [];
    return updates;
  }

  static emptyUint32x4 = (() => {
    const { width, height, depth, maxSplats } = getTextureSize(1);
    const emptyArray = new Uint32Array(maxSplats * 4);
    const texture = new THREE.DataArrayTexture(
      emptyArray,
      width,
      height,
      depth,
    );
    texture.format = THREE.RGBAIntegerFormat;
    texture.type = THREE.UnsignedIntType;
    texture.internalFormat = "RGBA32UI";
    texture.needsUpdate = true;
    return texture;
  })();

  static emptyUint32x2 = (() => {
    const { width, height, depth, maxSplats } = getTextureSize(1);
    const emptyArray = new Uint32Array(maxSplats * 2);
    const texture = new THREE.DataArrayTexture(
      emptyArray,
      width,
      height,
      depth,
    );
    texture.format = THREE.RGIntegerFormat;
    texture.type = THREE.UnsignedIntType;
    texture.internalFormat = "RG32UI";
    texture.needsUpdate = true;
    return texture;
  })();

  static emptyIndicesTexture = (() => {
    const emptyArray = new Uint32Array(4096 * 4);
    const texture = new THREE.DataTexture(emptyArray, 4096, 1);
    texture.format = THREE.RGBAIntegerFormat;
    texture.type = THREE.UnsignedIntType;
    texture.internalFormat = "RGBA32UI";
    texture.needsUpdate = true;
    return texture;
  })();

  static emptyPackedTexture = this.emptyUint32x4;
  static emptyExtTexture = this.emptyUint32x4;
  static emptySh1Texture = this.emptyUint32x2;
  static emptySh2Texture = this.emptyUint32x4;
  static emptySh3Texture = this.emptyUint32x4;
  static emptyExtSh1Texture = this.emptyUint32x4;
  static emptyExtSh2Texture = this.emptyUint32x4;
  static emptyExtSh3Texture = this.emptyUint32x4;
  static emptyExtSh3BTexture = this.emptyUint32x4;
}

function getGlTexture(
  renderer: THREE.WebGLRenderer,
  texture: THREE.Texture,
): WebGLTexture {
  if (!renderer.properties.has(texture)) {
    throw new Error("texture not found");
  }
  const props = renderer.properties.get(texture) as {
    __webglTexture: WebGLTexture;
  };
  const glTexture = props.__webglTexture;
  if (!glTexture) {
    throw new Error("texture not found");
  }
  return glTexture;
}

const wasmInitialized = init_wasm();

async function fetchRange({
  url,
  requestHeader,
  withCredentials,
  offset,
  bytes,
}: {
  url: string;
  requestHeader?: Record<string, string>;
  withCredentials?: boolean;
  offset?: number;
  bytes?: number;
}): Promise<Uint8Array> {
  const request = new Request(url, {
    headers: requestHeader ? new Headers(requestHeader) : undefined,
    credentials: withCredentials ? "include" : "same-origin",
  });
  if (offset !== undefined && bytes !== undefined) {
    request.headers.set("Range", `bytes=${offset}-${offset + bytes - 1}`);
  }
  const response = await fetch(request);
  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to fetch "${url}": ${response.status} ${response.statusText}`,
    );
  }
  return new Uint8Array(await response.arrayBuffer());
}

// =============================================================================
// Range Coalescing: fetch multiple byte-adjacent chunks in one HTTP request
// to amortize per-request RTT overhead on high-latency links.
// =============================================================================

interface CoalesceStats {
  coalesced_requests: number;
  single_requests: number;
  total_chunks_fetched: number;
  useful_bytes: number;
  overfetch_bytes: number;
}

const coalesceCache = new Map<string, { buffer: Uint8Array; offset: number; bytes: number }>();
const coalesceStats: CoalesceStats = {
  coalesced_requests: 0,
  single_requests: 0,
  total_chunks_fetched: 0,
  useful_bytes: 0,
  overfetch_bytes: 0,
};

// Expose stats for instrumentation
if (typeof window !== "undefined") {
  (window as Window & { __coalesceStats?: CoalesceStats }).__coalesceStats = coalesceStats;
}

/**
 * Fetch chunk `chunkIdx` from a RAD file, coalescing up to `maxCoalesce`
 * byte-adjacent subsequent chunks into a single Range request.
 *
 * Returns the bytes for the requested chunk. Side effect: caches the
 * extra chunks so subsequent fetchDecodeChunk calls find them instantly.
 */
async function fetchRangeCoalesced({
  url,
  requestHeader,
  withCredentials,
  chunkIdx,
  meta,
  chunksStart,
  maxCoalesce,
}: {
  url: string;
  requestHeader?: Record<string, string>;
  withCredentials?: boolean;
  chunkIdx: number;
  meta: RadMeta;
  chunksStart: number;
  maxCoalesce: number;
}): Promise<Uint8Array> {
  const chunks = meta.chunks;
  const primary = chunks[chunkIdx];
  const primaryOffset = primary.offset + chunksStart;
  const primaryBytes = primary.bytes;

  // Check coalesce cache first (this chunk may have been fetched as part of a previous coalesce)
  const cacheKey = `${url}#${primaryOffset}`;
  const cached = coalesceCache.get(cacheKey);
  if (cached) {
    coalesceCache.delete(cacheKey); // one-shot cache
    coalesceStats.total_chunks_fetched += 1;
    coalesceStats.useful_bytes += cached.bytes;
    return cached.buffer;
  }

  // Determine how many contiguous chunks we can coalesce
  // Rules: byte-adjacent (no gap), no filename chunks, within manifest bounds
  let coalesceCount = 1;
  let totalBytes = primaryBytes;
  let endOffset = primaryOffset + primaryBytes;

  for (let k = 1; k < maxCoalesce && chunkIdx + k < chunks.length; k++) {
    const next = chunks[chunkIdx + k];
    if (next.filename) break; // can't coalesce across file boundaries
    const nextOffset = next.offset + chunksStart;
    if (nextOffset !== endOffset) break; // not byte-adjacent
    // Don't coalesce if already in cache
    const nextCacheKey = `${url}#${nextOffset}`;
    if (coalesceCache.has(nextCacheKey)) break;
    coalesceCount += 1;
    totalBytes += next.bytes;
    endOffset = nextOffset + next.bytes;
  }

  // Fetch the coalesced range
  const fetchedBytes = await fetchRange({
    url,
    requestHeader,
    withCredentials,
    offset: primaryOffset,
    bytes: totalBytes,
  });

  if (coalesceCount > 1) {
    coalesceStats.coalesced_requests += 1;
  } else {
    coalesceStats.single_requests += 1;
  }

  // Split the response and cache extra chunks
  let sliceOffset = 0;
  let primaryResult: Uint8Array | undefined;

  for (let k = 0; k < coalesceCount; k++) {
    const c = chunks[chunkIdx + k];
    const slice = fetchedBytes.slice(sliceOffset, sliceOffset + c.bytes);
    sliceOffset += c.bytes;

    if (k === 0) {
      primaryResult = slice;
      coalesceStats.total_chunks_fetched += 1;
      coalesceStats.useful_bytes += c.bytes;
    } else {
      // Cache for future fetchDecodeChunk calls
      const nextOffset = c.offset + chunksStart;
      const nextCacheKey = `${url}#${nextOffset}`;
      coalesceCache.set(nextCacheKey, { buffer: slice, offset: nextOffset, bytes: c.bytes });
      coalesceStats.total_chunks_fetched += 1;
      coalesceStats.useful_bytes += c.bytes;
    }
  }

  // overfetch = bytes fetched beyond what's useful (should be 0 for contiguous coalesce)
  // but track it for safety
  if (fetchedBytes.byteLength > totalBytes) {
    coalesceStats.overfetch_bytes += fetchedBytes.byteLength - totalBytes;
  }

  return primaryResult!;
}
