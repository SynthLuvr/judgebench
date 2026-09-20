type Manifest = {
  readonly run_id: string;
  readonly created: string;
  readonly config_hash: string;
  readonly adapter_version: string;
  readonly dataset_hash: string;
  readonly judges: readonly string[];
};

// TODO Phase 1: resolved-config snapshot, config + dataset content hashes,
// adapter semver, and the --resume index over completed sample_ids.
const writeManifest = async (_manifest: Manifest): Promise<void> => undefined;

export type { Manifest };
export { writeManifest };
