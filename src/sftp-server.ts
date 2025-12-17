import fs from 'fs';
import { Attributes, Server, Connection } from 'ssh2';
import path from 'path';
import crypto from 'crypto';
import tmp from 'tmp';
import { VirtualFileSystem } from './virtual-file-system';
import { JsonFileSystem } from './json-file-system';
import { ImmichFileSystem } from './immich-file-system';
import { ensureHostKeySync } from "./ensure-host-key";

// SFTP Statuscodes
const STATUS_CODE = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4
};

//Set backend filesystem
interface ImmichSftpConnection extends Connection {
  fsBackend?: VirtualFileSystem;
}

//Generate host key if not exists
const hostKey = ensureHostKeySync("./cert");

//Create the SFT Server
const server = new Server({
  hostKeys: [hostKey]
}, (con: ImmichSftpConnection) => {
  console.log('Client connected');

  con.on('authentication', async (ctx) => {
    console.log(`Authenticating user: ${ctx.username} (method: ${ctx.method})`);

    if (ctx.method === 'password') {

      // Initialize the file system backend 
      if (con.fsBackend == null) {
        con.fsBackend = new ImmichFileSystem();
        //con.fsBackend = new JsonFileSystem('./data/sftp-data.json');
      }

      //Login
      try {
        await con.fsBackend.login(ctx.username, ctx.password);
      } catch (err) {
        console.error(`Authentication failed for user ${ctx.username}:`, err);
        return ctx.reject();
      }

      console.log(`User ${ctx.username} authenticated successfully`);
      ctx.accept();
    }
    else {
      // Return supported authentication methods
      return ctx.reject(['password']);
    }
  });

  con.on('end', async () => {
    // Close the file system backend if it exists
    if (con.fsBackend) {
      await con.fsBackend.logout();
    }

    console.log('Client disconnected');
  });

  con.on('ready', () => {
    console.log('Client is ready');

    con.on('session', (accept, reject) => {
      const session = accept();
      console.log('Session started');


      session.on('sftp', (accept, reject) => {
        //Accept SFTP session
        const sftpStream = accept();
        console.log('SFTP session started');

        //Find backend or close connection
        const fsBackend = con.fsBackend;
        if (!fsBackend) {
          console.error('File system backend is not initialized. Closing connection.');
          return con.end();
        }

        //Handle map
        const handleMap: Record<string, HandleEntry> = {};

        sftpStream.on('REALPATH', (reqid, givenPath) => {
          try {
            const normalized = normalizePath(givenPath)
            console.log(`REALPATH requested for: ${givenPath} → ${normalized}`);
            sftpStream.name(reqid, [{
              filename: normalized,
              longname: normalized,
              attrs: {
                mode: 0o040755, // Octal mode: directory flag (0o040000) + permissions (0o755 = drwxr-xr-x)
                uid: 0,
                gid: 0,
                size: 0,
                atime: Math.floor(Date.now() / 1000),
                mtime: Math.floor(Date.now() / 1000)
              }
            }]);
          } catch (e) {
            console.error('REALPATH error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

        sftpStream.on('OPENDIR', (reqid, path) => {
          try {
            const handle = crypto.randomBytes(4);
            const handleHex = handle.toString('hex');
            console.log(`OPENDIR requested for: '${path}', handle: ${handleHex}`);

            handleMap[handleHex] = {
              path: path,

              //Directory Handling
              directoryEntryRead: false,

              //Write files
              writeTmpFile: null,

              //Read files content
              readInitPromise: null,
              readTmpFile: null,
              readSize: null
            };

            sftpStream.handle(reqid, handle);
          } catch (e) {
            console.error('OPENDIR error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

        sftpStream.on('READDIR', async (reqid, handle) => {
          try {
            const key = handle.toString('hex');
            console.log(`READDIR on handle: ${key}`);
            const entry = handleMap[key];

            if (!entry.directoryEntryRead) {
              const pathStr = handleMap[key].path;
              const files = await fsBackend.listFiles(pathStr);

              if (files.length === 0) {
                sftpStream.name(reqid, [{
                  filename: '.',
                  longname: 'drwxr-xr-x 1 user group 0 Jan 1 00:00 .',
                  attrs: {
                    mode: 0o040755,// Octal mode: directory flag (0o040000) + permissions (0o755 = drwxr-xr-x)
                    uid: 0,
                    gid: 0,
                    size: 0,
                    mtime: Date.now() / 1000,
                    atime: Date.now() / 1000
                  }
                }]);
              } else {

                const entries = files.map(file => {
                  const perms = file.isDir ? 'drwxr-xr-x' : '-rw-r--r--';
                  const date = new Date(file.mtime * 1000);
                  const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD

                  return {
                    filename: file.name,
                    longname: `${perms} 1 user group ${file.size} ${dateStr} ${file.name}`,
                    attrs: {
                      size: file.size,
                      mtime: file.mtime,
                      atime: file.mtime,
                      mode: file.isDir ? 0o040755 : 0o100644,
                      uid: 0, // You can adjust these as needed
                      gid: 0
                    }
                  };
                });

                sftpStream.name(reqid, entries);
              }
              entry.directoryEntryRead = true; // Dass Einträge nicht mehrfach gelesen werden, der client darf mehrere anfragen senden
            } else {
              sftpStream.status(reqid, STATUS_CODE.EOF);
            }
          } catch (e) {
            console.error('READDIR error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

        sftpStream.on('OPEN', async (reqid, filename, flags, attrs) => {
          try {
            const normalized = normalizePath(filename);
            const handle = crypto.randomBytes(4);
            const handleHex = handle.toString('hex');
            console.log(`OPEN for: '${normalized}', handle: ${handleHex}`);

            handleMap[handleHex] = {
              path: filename,

              //Directory Handling
              directoryEntryRead: null,

              //Write files
              writeTmpFile: null,

              //Read files content
              readInitPromise: null,
              readTmpFile: null,
              readSize: null
            };

            sftpStream.handle(reqid, handle);
          } catch (e) {
            console.error('OPEN error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

        sftpStream.on('READ', async (reqid, handle, offset, length) => {
          try {
            /**
             * Handles READ requests from the SFTP client.
             *
             * SFTP clients (like FileZilla, WinSCP, or OpenSSH `sftp`) typically:
             *
             * 1. Send multiple READ requests asynchronously and in parallel (pipelined), even before earlier ones complete.
             *    → We address this by guarding the one-time file initialization (`readInitPromise`) with a shared Promise.
             *      All READ requests await this Promise to ensure the file is only loaded once and in order.
             *
             * 2. Issue more READ requests than strictly required, often reading well beyond EOF.
             *    These may include:
             *      - READs past the end of the file (over-reads).
             *      - READs that arrive even after the file handle has been closed and the temporary file deleted (due to a CLOSE).
             *
             *    → To prevent unnecessary or invalid file access:
             *      - We store the file size (`entry.readSize`) after loading it, and compare each READ request’s `offset` to that size.
             *        If the offset is beyond EOF, we immediately return `STATUS_CODE.EOF`.
             *      - As we are not touching the file in case offset is beyond EOF, we can safely ignore any READ requests that come in after the file has been closed.
             *
             */

            // Get handle and log
            const key = handle.toString('hex');
            // todo console.log(`READ ${length} bytes for handle ${key}`);
            const entry = handleMap[key];

            //Get Async data of first call
            if (!entry.readInitPromise) {
              entry.readInitPromise = (async () => {
                //Get Immich asse as tmp file
                entry.readTmpFile = await fsBackend.readFile(entry.path);

                // Get file size from the tmp file on disk
                const stats = fs.statSync(entry.readTmpFile.name);
                entry.readSize = stats.size;
              })();
            }

            // Wait for init to complete, in case multiple reads came in
            await entry.readInitPromise;

            // Both entry fields Can't be null, but need to check to be type safe
            if (entry.readTmpFile == null || entry.readSize == null) {
              console.error(`READ failed: readTmpFile or readSize missing for handle ${key}`);
              return sftpStream.status(reqid, STATUS_CODE.FAILURE);
            }

            // Check if offset is beyond file size
            if (offset >= entry.readSize) {
              // todo console.log(`READ is beyond EOF for handle ${key}`);
              return sftpStream.status(reqid, STATUS_CODE.EOF);
            }

            //Read from tmp file
            const buffer = Buffer.alloc(length);
            const bytesRead = fs.readSync(entry.readTmpFile.fd, buffer, 0, length, offset);

            //Check EOF. This should not happen, but just in case
            if (bytesRead === 0) {
              // todo console.log(`READ is beyond EOF of file for handle ${key}`);
              return sftpStream.status(reqid, STATUS_CODE.EOF);
            }

            // Send only the actual bytes read (in case it's less than requested length)
            sftpStream.data(reqid, buffer.slice(0, bytesRead));
          } catch (e) {
            console.error('READ error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

        sftpStream.on('WRITE', async (reqid, handle, offset, data) => {
          const key = handle.toString('hex');
          // todo console.log(`WRITE ${data.length} bytes for handle ${key}`);
          const entry = handleMap[key];

          // Create tmp file on first call
          if (entry.writeTmpFile == null) {
            entry.writeTmpFile = tmp.fileSync();
          }

          // Write data
          fs.writeSync(entry.writeTmpFile.fd, data, 0, data.length, offset);
          sftpStream.status(reqid, STATUS_CODE.OK);
        });

        sftpStream.on('CLOSE', async (reqid, handle) => {
          try {
            const key = handle.toString('hex');
            console.log(`CLOSE handle: ${key}`);
            const entry = handleMap[key];

            // Remove tmp file
            if (entry.readTmpFile != null) {
              entry.readTmpFile.removeCallback();
            }

            // Save data and remove tmp file
            if (entry.writeTmpFile != null) {
              //Write file to backend
              await fsBackend.writeFile(entry.path, entry.writeTmpFile);
            }

            // Remove handle and return ok
            delete handleMap[key];
            sftpStream.status(reqid, STATUS_CODE.OK);
          } catch (e) {
            console.error('CLOSE error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

        sftpStream.on('STAT', async (reqid, filePath) => {
          try {
            const normalized = normalizePath(filePath);
            console.log(`STAT requested for: ${filePath} → ${normalized}`);

            //Falls das root dir angefragt wird
            if (normalized === '/') {
              return sftpStream.attrs(reqid, {
                mode: 0o040755, // Verzeichnis mit rwxr-xr-x
                uid: 0,
                gid: 0,
                size: 0,
                mtime: Date.now() / 1000,
                atime: Date.now() / 1000
              });
            }

            //Datei nicht gefunden
            const stat = await fsBackend.stat(normalized);
            if (!stat) {
              console.log(`STAT: file not found → returning NO_SUCH_FILE`);
              return sftpStream.status(reqid, STATUS_CODE.NO_SUCH_FILE);
            }

            //Datei gefunden
            sftpStream.attrs(reqid, {
              mode: stat.isDir ? 0o040755 : 0o100644,
              uid: 0,
              gid: 0,
              size: stat.size,
              mtime: stat.mtime,
              atime: stat.mtime
            });
          } catch (e) {
            console.error('STAT error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

        sftpStream.on('SETSTAT', async (reqid, filePath, attrs: Attributes) => {
          try {
            const normalized = normalizePath(filePath);
            console.log(`SETSTAT: ${normalized}`, attrs);

            await fsBackend.setAttributes(normalized, attrs.mtime);
            sftpStream.status(reqid, STATUS_CODE.OK);
          } catch (e) {
            console.error('SETSTAT error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

        sftpStream.on('RENAME', async (reqid, oldPath, newPath) => {
          try {
            const oldName = normalizePath(oldPath);
            const newName = normalizePath(newPath);
            console.log(`RENAME requested: ${oldName} → ${newName}`);

            await fsBackend.rename(oldName, newName);
            sftpStream.status(reqid, STATUS_CODE.OK);
          } catch (e) {
            console.error('RENAME error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

        sftpStream.on('REMOVE', async (reqid, filePath) => {
          try {
            const normalized = normalizePath(filePath);
            console.log(`REMOVE requested: ${normalized}`);

            await fsBackend.remove(normalized);
            sftpStream.status(reqid, STATUS_CODE.OK);
          } catch (e) {
            console.error('REMOVE error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

        sftpStream.on('MKDIR', async (reqid, dirPath, attrs) => {
          try {
            const normalized = normalizePath(dirPath);
            console.log(`MKDIR: ${normalized}`);

            await fsBackend.mkdir(normalized);
            sftpStream.status(reqid, STATUS_CODE.OK);
          } catch (e) {
            console.error('MKDIR error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

        sftpStream.on('RMDIR', async (reqid, dirPath) => {
          try {
            const normalized = normalizePath(dirPath);
            console.log(`RMDIR: ${normalized}`);

            await fsBackend.remove(normalized);
            sftpStream.status(reqid, STATUS_CODE.OK);
          } catch (e) {
            console.error('RMDIR error:', e);
            sftpStream.status(reqid, STATUS_CODE.FAILURE);
          }
        });

      });
    });
  });
});

//Start the Server
server.listen(22, '0.0.0.0', function () {
  console.log('SFTP server listening on port 22');
});


//Helper
function normalizePath(p: string): string {
  const normalized = path.posix.normalize(p);  // Pfade auflösen: z.B. 'foo//bar/../baz' → 'foo/baz'
  const absPath = normalized.replace(/^\/+|\/+$/g, ''); // führende und abschließende Slashes entfernen
  return "/" + absPath;
}

//Data classes
interface HandleEntry {
  path: string;

  //Directory Handling
  directoryEntryRead: boolean | null;

  //Write files
  writeTmpFile: tmp.FileResult | null;

  //Read files content
  readInitPromise: Promise<void> | null;
  readTmpFile: tmp.FileResult | null;
  readSize: number | null;
}