// Optional folder allow-list for local files this server reads and uploads (media and customer lists). With SNAP_MEDIA_DIR set,
// a file must be inside that folder after symbolic links are resolved, so an instruction hidden in an ad name or a web page
// cannot make the server read some other file on the computer.
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export function assertFileAllowed(filePath, mediaDir) {
  if (!mediaDir) return;
  let real;
  let root;
  try {
    root = realpathSync(mediaDir);
  } catch {
    throw new Error(`SNAP_MEDIA_DIR (${mediaDir}) does not exist or cannot be read.`);
  }
  try {
    real = realpathSync(resolve(String(filePath)));
  } catch {
    throw new Error(`File not found: ${filePath}`);
  }
  const rel = relative(root, real);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`That file is outside the folder allowed by SNAP_MEDIA_DIR (${mediaDir}). Put the file inside that folder and try again.`);
  }
}
