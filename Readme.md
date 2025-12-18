# Immich SFTP Server

An **SFTP “bridge” for Immich**: browse your Immich albums like folders and upload/download photos & videos with an SFTP Client.

## Ideas to use this 💡

- Two-way synchronize your Immich library with your phone (recommended app: FolderSync)
- Import your existing folder-based library as Immich albums
- Synchronize or connect Immich with any file-based third-party system
- Maybe for backups? (Important and recommended: Do proper backups of the whole Immich instance — see https://docs.immich.app/administration/backup-and-restore/)


## Motivation & background 💪🏻

I’m a Nextcloud user for many years and I’m really happy with it. I have always synchronized my photos and videos with the FolderSync app for Android, which is a very reliable solution, even for large libraries (400 GB+). But no matter what you do, Nextcloud will never get a media management system as good as Immich. At the same time, Immich is still lacking a good two-way synchronization.  

That’s why I came up with this solution. It allows me to reliably sync thousands and tens of thousands of media files with Immich and get reliable reports in the sync app.
It also allows me to do most of the photo sorting on the phone, which is then reflected in Immich. And if I do some sorting on the computer in Immich, it will be reflected back to the phone.

## Important technical facts ⚙️

- All actions in this project are **100% based on the official Immich API**. No access to or messing around with Immich internals.
- **No data or metadata is stored** in this container. So it’s not relevant for your backups, and you can stop using it at any point without data loss.

---

## How it works (Immich ↔ SFTP mapping) 🧭

### Albums → folders

- Root (`/`) lists the albums the user has in Immich.
- Creating a new folder in SFTP will create a new album in Immich.
- Add `#nosync` somewhere into an album description in Immich to hide it from SFTP.

### Assets → files

Inside an album folder, files represent assets. Every asset you have added to an album will be shown inside its SFTP folder.

The file list you see is completely built from the metadata stored in Immich:

- **Filename:** the `originalFileName` the asset had when it was uploaded to Immich
- **Modified time:** datetime from the asset
- **Size:** file size of the asset

### Uploads ⬆️

Uploading files to SFTP is handled by the following rules:

- Files can only be uploaded into album folders, not into the root folder.
- Upload a **new file**
  - → a **new asset** is created in Immich and **added to that album**
- Upload a file that **already exists** in Immich
  -  → it is **deduplicated** (no duplicate created) and **added to that album**
- Upload a file that was **previously deleted** and is still in the trash
  -  → the asset is **restored from trash** and **added to that album**

### Deleting 🗑️

Delete items from your SFTP client:

- **Delete a file**:
  - if the asset is **only in this album** → it is moved to the **Immich trash**
  - if the asset is also in **other albums** → it is **removed from this album only**
- **Delete an album folder** → the **album is deleted** in Immich  
  > ⚠️ Important: Your SFTP client usually deletes all files inside a folder as well, so assets are also removed according to the rules above. If you could prevent the client from doing so, only the album would be removed, but the assets would not go to the trash.

### Downloads ⬇️

Any file can be downloaded from SFTP and you will get the file as it was originally uploaded to Immich.

---

## Deployment (Docker Compose) 🐳

### Install on the Immich stack (recommended)

```diff
name: immich

services:
  immich-server:
    container_name: immich_server
    [...]

  immich-machine-learning:
    container_name: immich_machine_learning
    [...]
  
  redis:
    container_name: immich_redis
    [...]

  database:
    container_name: immich_postgres
     [...]
  
+ immich-sftp:
+   container_name: immich_sftp
+   image: ghcr.io/demian98/immich-sftp-server:latest 
+   ports:
+    - "22832:22"
+   environment:
+     IMMICH_HOST: http://immich-server:2283
+     TZ: Europe/Berlin
+   restart: unless-stopped

volumes:
  [...]

```

### Standalone

```yaml
services:
  immich-sftp:
    container_name: immich_sftp
    image: ghcr.io/demian98/immich-sftp-server:latest 
    ports:
      - "22832:22"
    environment:
      IMMICH_HOST: https://<your-immich-server-fqdn>:<immich-port>
      TZ: <your TZ>
    restart: unless-stopped
```

### Connect / Test it ✅

Use any SFTP client:

- **Host:** your server hostname/IP
- **Port:** `22832` (from the compose example)
- **Username:** your Immich email
- **Password:** your Immich password

---

## Supported clients 🤝

- FolderSync for Android (https://foldersync.io/)
- WinSCP (https://winscp.net/)

> Most likely most clients will just work — I don’t expect issues. But the two above are tested and working ✅

---

## Known limitations 🧩

- **Renaming files is not possible.** The `originalFileName` in Immich metadata can’t be changed. Because of that, it’s impossible to rename a file via SFTP.
- **Albums are not available** on SFTP when:
  - they contain characters that are invalid for a filename
  - the same album name is used multiple times
- If an album contains multiple assets with the **same original filename**, SFTP clients may not handle it well. Technically this is possible in Immich — try to prevent it.
- You can’t create subfolders, because nested albums are not possible in Immich.

---
