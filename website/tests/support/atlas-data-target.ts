/**
 * Which data origin a built site's Atlas reads, for the performance harness
 * (design 2026-10-07 §C.3): the bucket (an absolute https base) or a local
 * staging tree served on 127.0.0.1:4323 from ATLAS_DATA_DIR. After Part C a
 * same-origin build has no per-artifact data, so it is refused loudly.
 */
export const LOCAL_DATA_BASE = 'http://127.0.0.1:4323/';

export type AtlasDataTarget =
  | { kind: 'bucket'; base: string }
  | { kind: 'local'; base: string; directory: string };

export function atlasDataTarget(
  appHtml: string,
  dataDirectory: string | undefined,
): AtlasDataTarget {
  const match =
    /<script[^>]*\bid="atlas-data-bases"[^>]*>([^<]*)<\/script>/.exec(appHtml);
  if (!match)
    throw new Error(
      'dist/app/index.html has no #atlas-data-bases element; run npm run build first',
    );
  const { artifact } = JSON.parse(match[1]!) as { artifact: string };
  if (artifact === LOCAL_DATA_BASE) {
    if (!dataDirectory)
      throw new Error(
        `this build reads Atlas data from ${LOCAL_DATA_BASE}; set ATLAS_DATA_DIR to a staging tree (encode_atlas_web.py --with-downloads --out DIR)`,
      );
    return { kind: 'local', base: artifact, directory: dataDirectory };
  }
  if (artifact.startsWith('https://'))
    return { kind: 'bucket', base: artifact };
  throw new Error(
    `this build reads Atlas data from ${JSON.stringify(artifact)}; rebuild with PUBLIC_ATLAS_DATA_BASE_URL set to the bucket base or ${LOCAL_DATA_BASE}`,
  );
}
