const appendJsonl = async (_path: string, _record: unknown): Promise<void> =>
  undefined;

// TODO Phase 1: append-only JSONL writer/reader for
// runs/<id>/judgments.jsonl — wire both functions up together.
const readJsonl = async (_path: string): Promise<unknown[]> => [];

export { appendJsonl, readJsonl };
