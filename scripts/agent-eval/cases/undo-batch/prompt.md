# Task

You have the Klippt agent CLI (`klippt agent …`). A cloned project is open:
project id `{project_id}`, file `{project_path}`.

1. Compose three small pause trims from the pause detector's suggestions. Apply
   each trim as one mutation in a single three-step batch. Let the batch derive
   its request IDs so all three mutations belong to one undo group.
2. Undo the entire batch in one step with its group ID.

When you finish, the saved project content must equal the starting content,
while new recovery receipts and undo history remain intact. The staged lane
must be empty. Prove content restoration and report the before/after file hashes;
transaction metadata and `project.updatedAt` mean complete file bytes can differ after undo.
Never overwrite the project file directly, including copying a backup over it.
Use the CLI for every project write. Report unsupported operations honestly.
