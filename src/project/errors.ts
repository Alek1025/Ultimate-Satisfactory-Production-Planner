export type ProjectErrorCode =
  | 'EXISTS' // create() target already exists
  | 'NOT_FOUND' // file, revision, snapshot, ref or blob missing
  | 'NOT_A_PROJECT' // file is not a .ussp (wrong application_id or no schema)
  | 'SCHEMA_TOO_NEW' // written by a newer version of the app
  | 'CORRUPT' // integrity check or content hash failed
  | 'BAD_EDIT' // a journal op is malformed or does not apply to the working state
  | 'OP_ID_CONFLICT' // an op id was reused for a different op
  | 'REF_CONFLICT' // compare-and-swap on a ref failed, or the ref name is invalid/taken
  | 'PENDING_EDITS' // a ref with unfolded journal entries was moved or deleted
  | 'INVALID'; // other bad input

export class ProjectError extends Error {
  constructor(readonly code: ProjectErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProjectError';
  }
}
