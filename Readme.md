# Immich SFTP Server

Test text

TODO This project provides an SFTP server that integrates with [Immich](https://github.com/immich-app/immich), enabling users to upload media files directly to their Immich instance via SFTP.

## Installation

### 🛠 Build & Export

```
docker build -t immich-sftp-server:1.0 .
docker save -o immich-sftp-server-1.0.tar immich-sftp-server:1.0
```

### 📦 Import on Docker Host 

```
	docker load -i sapexchangeclient_latest.tar
	Or use portainer to import the image.
```

### Compose file

```
services:
  immich-sftp:
    container_name: immich-sftp
    image: immich-sftp-server:latest
    ports:
      - "22:22"  # Expose SFTP on standard port
    environment:
      IMMICH_HOST: https://immich-test.welker.dynu.net
    restart: unless-stopped
```

## Features

This SFTP server provides seamless integration with [Immich](https://github.com/immich-app/immich), enabling file-based workflows for photo and video management. Key features include:

---

### 🔐 SFTP Access
- Standard SFTP protocol over port `2222`
- Compatible with clients like FileZilla, WinSCP, Cyberduck, and OpenSSH
- Username/password authentication mapped to Immich user accounts

---

### 📂 Album as Folder Mapping
- Immich albums appear as top-level directories
- Assets (photos, videos) are shown as regular files inside albums
- Supports folder-like browsing and navigation via SFTP

---

### ⬆️ File Upload with Deduplication
- Uploads automatically detect duplicates using SHA-1 hash
- Already existing assets are reused — no redundant uploads
- Assets in the trash are restored instead of re-uploaded

---

### ➕ Multi-Album Support
- Assets can be added to multiple albums without duplication
- Uploading the same file into a different folder adds it to the corresponding album

---

### ♻️ Trash Handling
- Assets deleted from a single album are removed only from that album
- Assets deleted from their last album are moved to the trash
- Re-uploading a trashed asset restores it and updates its album association

---

### 🕑 Metadata Preservation
- Original filenames and modified timestamps are preserved
- Immich assets are tagged with creation and modification times based on SFTP metadata

---

### 🗂️ Temporary Files for Safe Transfer
- Uploads and downloads are buffered through temporary files for stability
- Supports large files, parallel transfers, and interrupted session recovery

---

### 🛠️ Read/Write/Delete/Stat Operations
- Full support for SFTP operations:
  - `OPEN`, `READ`, `WRITE`, `CLOSE`
  - `STAT`, `SETSTAT`, `RENAME`, `REMOVE`, `MKDIR`, `RMDIR`
- Behavior mirrors expected Unix filesystem semantics where possible

---

This feature set allows photographers, automation scripts, or backup tools to interact with Immich using simple file operations, while maintaining full compatibility with Immich's data model and API logic.



## Business Logic: SFTP Events and Immich Integration

This section describes how each SFTP event is handled internally by the server and which actions are triggered in Immich.

---

### `OPENDIR` / `READDIR`
**Purpose:** List albums and assets.

**Behavior:**
- At root `/`, returns the list of **albums** (each album is treated as a directory).
- Inside an album, returns a list of **assets** (each asset is treated as a file).
- Data is fetched from Immich and cached for session reuse.

---

### `OPEN` / `READ`
**Purpose:** Read an asset (download).

**Behavior:**
- Asset is streamed from Immich using the `/assets/:id/original` API.
- A temporary file is created on disk for safe reading.
- Multiple parallel `READ` requests are supported and synchronized.

---

### `WRITE`
**Purpose:** Upload an asset (write).

**Behavior:**
- Incoming data is written to a temporary file on disk.
- File remains in the upload queue until the final `SETSTAT` is called.

---

### `SETSTAT`
**Purpose:** Finalize asset upload.

**Behavior:**
- Computes SHA-1 hash of the file to check for duplicates using `bulk-upload-check`.
- If new: uploads to Immich via `/assets` and associates it with the target album.
- If in trash: restores the asset, removes it from any previous albums, and adds it to the new one.
- If duplicate: skips upload and directly adds the asset to the target album.

---

### `CLOSE`
**Purpose:** Clean up after read or write.

**Behavior:**
- For reads: deletes the temporary file used for reading.
- For writes: temporarily retains the file until `SETSTAT` is received.

---

### `STAT`
**Purpose:** Fetch metadata for files or albums.

**Behavior:**
- Returns file size, last modified time, and type (directory or file).
- Data comes from Immich album/asset metadata.

---

### `RENAME`
**Purpose:** Rename an asset (write queue only).

**Behavior:**
- Only supported **before** the asset is uploaded to Immich.
- Updates the name in the upload queue.
- **Not supported** after upload; Immich does not support renaming assets.

---

### `REMOVE`
**Purpose:** Delete a file or album.

**Behavior:**
- If it's an **asset**:
  - If in multiple albums: asset is **removed only** from the current album.
  - If in a single album: asset is **moved to trash** in Immich.
- If it's an **album**:
  - All assets inside the album are deleted or removed.
  - The album itself is deleted from Immich.

---

### `MKDIR`
**Purpose:** Create a new album.

**Behavior:**
- Only allowed at root level (`/`).
- Creates a new album in Immich with the given name.

---

### `RMDIR`
**Purpose:** Remove an album.

**Behavior:**
- Deletes all assets inside the album (with rules as per `REMOVE`).
- Deletes the album itself from Immich.

---

### `REALPATH`
**Purpose:** Normalize paths.

**Behavior:**
- Ensures client paths are resolved correctly and presented in standard `/album/asset` format.


## Compatibility & Regression Tests

When updating this software or after a new release of [Immich](https://github.com/immich-app/immich), it's essential to verify that all key SFTP features work as expected. The following manual test cases help ensure that integration with Immich behaves correctly and consistently.

### Test 1 – Upload and Download Roundtrip
**Steps:**
1. Upload an asset via SFTP.
2. Download the same asset via SFTP.

**Expected Result:**
- The filename and last modified date must remain unchanged.
- File content must be identical to the original.

---

### Test 2 – Upload to Multiple Albums
**Steps:**
1. Upload an asset into Album A.
2. Upload the same asset into Album B.

**Expected Result:**
- The asset should only be stored once in Immich (no duplication).
- The asset must appear in both albums.

---

### Test 3 – Duplicate Detection on Large Files
**Steps:**
1. Repeat **Test 1** with a large file (e.g., a video).
2. Perform the upload to Album A, then again to Album B.

**Expected Result:**
- Upload speed should be similar for both uploads.
- On the **first upload**, a delay during the `SETSTAT` call is expected due to actual upload to Immich.
- On the **second upload**, `SETSTAT` should complete quickly, as the file is detected as a duplicate and only linked to the second album.

---

### Test 4 – Remove Asset From One Album
**Steps:**
1. Upload an asset into **two** albums.
2. Delete the asset from one album via SFTP.

**Expected Result:**
- The asset should remain in Immich and stay associated with the other album.
- It must only be removed from the specified album.

---

### Test 5 – Delete Asset From Last Album
**Steps:**
1. Upload an asset to a **single** album.
2. Delete the asset via SFTP.

**Expected Result:**
- The asset should be moved to the trash in Immich.
- Its album association should remain visible (check in the Immich web UI under asset details).

---

### Test 6 – Re-upload Trashed Asset to a Different Album
**Steps:**
1. Upload an asset and delete it via SFTP (moves to trash).
2. Re-upload the same file into a **different** album.

**Expected Result:**
- Immich should detect the duplicate.
- The asset should be **restored from trash**.
- It should be **removed from the old album** (if any) and **assigned to the new album**.




## Limitations

*Todo*