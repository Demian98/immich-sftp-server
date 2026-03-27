import { VirtualFileSystem } from "./virtual-file-system";
import fs from 'fs';
import tmp from 'tmp';
import { pipeline } from 'stream/promises';
import { ImmichService } from './immich-service';
import { ParsedPath } from './immich-types';


// JSON-basiertes VirtualFileSystem-Backend
export class ImmichFileSystem implements VirtualFileSystem {

    private readonly immichService: ImmichService = new ImmichService();
    private uploadQueue: Array<{ filename: string; tmpFile: tmp.FileResult }> = [];

    private readonly allAlbumsFolder: string = 'all albums';
    private readonly untaggedAlbumsFolder: string = 'untagged albums';
    private readonly tagsFolder: string = 'tags';
    private readonly assetsWithoutAlbumFolder: string = 'assets without album';

    //Session handling    
    async login(username: string, password: string): Promise<void> {
        await this.immichService.login(username, password);
    }
    async logout(): Promise<void> {
        await this.immichService.logout();
    }

    
    //List or get files and directories
    async listFiles(currentDir: string): Promise<Array<{ name: string; isDir: boolean; size: number; mtime: number }>> {
        try {
            const parsedPath = this.parsePath(currentDir);

            switch (parsedPath.kind) {
                case "root":
                    return [
                        this.createDirEntry(this.allAlbumsFolder),
                        this.createDirEntry(this.untaggedAlbumsFolder),
                        this.createDirEntry(this.tagsFolder),
                        this.createDirEntry(this.assetsWithoutAlbumFolder),
                    ];

                case "virtualFolder":
                    if (parsedPath.virtualFolder == this.allAlbumsFolder) {
                        //Get all albums from Immich API
                        const albums = await this.immichService.getAllAlbums(false);

                        //Map albums to the expected format
                        return albums.map((album) => (this.createDirEntry(album.albumName)));
                    }
                    else if (parsedPath.virtualFolder == this.untaggedAlbumsFolder) {
                        //Get untagged albums
                        const untaggedAlbums = await this.immichService.getUntaggedAlbums(false);

                        //Map albums to the expected format
                        return untaggedAlbums.map((album) => (this.createDirEntry(album.albumName)));
                    }
                    else if (parsedPath.virtualFolder == this.tagsFolder) {
                        //Remove invalid or duplicate names
                        const tags = await this.immichService.getAllTags(true);

                        //Map tags to the expected format
                        return tags.map((tag) => (this.createDirEntry(tag.name)));
                    }
                    else if (parsedPath.virtualFolder == this.assetsWithoutAlbumFolder) {
                        //todo
                        return [
                            this.createDirEntry("todo"),
                        ];
                    }
                    break;

                case "tag": {
                    //Get albums for tag
                    const albumsForTag = await this.immichService.getAlbumsForTag(parsedPath, false);

                    //Map albums to the expected format
                    return albumsForTag.map((album) => (this.createDirEntry(album.albumName)));
                }

                case "album":
                case "tagAlbum": {
                    // Get album and fetch assets
                    const album = await this.immichService.getAlbumFromCache(parsedPath, false);
                    await this.immichService.fetchAssetsForAlbum(album);

                    // Map assets to the expected format
                    return (album.assets ?? []).map((asset) => ({
                        name: asset.originalFileName,
                        isDir: false,
                        size: asset.fileSizeInByte,
                        mtime: new Date(asset.fileModifiedAt).getTime() / 1000, // Convert to seconds
                    }));
                }

                case "asset":
                case "tagAsset":
                    throw new Error(`Cannot list files for asset path: ${currentDir}`);
            }

            throw new Error(`Unsupported directory path: ${currentDir}`);
        }
        catch (error) {
            console.error("Error fetching albums:", error);
            throw error;
        }
    }
    async readFile(filename: string): Promise<tmp.FileResult> {
        //todo refactor this: Stream not Buffer, Check and refresh cache

        // Get the asset from the cache
        const parsedPath = this.parsePath(filename);
        const asset = await this.immichService.getAssetFromCache(parsedPath, false);

        // Fetch the original file as a buffer
        const responseStream = await this.immichService.downloadAsset(asset.id);

        //Open tmp file stream
        const tmpFile = tmp.fileSync();
        const writeStream = fs.createWriteStream(tmpFile.name);

        //Write the immich stream to the tmp file
        await pipeline(responseStream, writeStream);
        return tmpFile;
    }
    async stat(filename: string): Promise<{ isDir: boolean; size: number; mtime: number; } | null> {
        // Determine if the path is a virtual folder, album or asset
        const parsedPath = this.parsePath(filename);

        switch (parsedPath.kind) {
            case "root":
            case "virtualFolder":
            case "tag":
                return {
                    isDir: true,
                    size: 0,
                    mtime: 0,
                };

            case "album":
            case "tagAlbum": {
                const album = await this.immichService.getAlbumOrNullFromCache(parsedPath, true);
                if (album) {
                    return {
                        isDir: true,
                        size: 0,    // Albums don't have a size
                        mtime: 0,   // Albums don't have a modification time
                    };
                }
                return null; // Album not found
            }

            case "asset":
            case "tagAsset": {
                const asset = await this.immichService.getAssetOrNullFromCache(parsedPath, true);
                if (asset) {
                    return {
                        isDir: false,
                        size: asset.fileSizeInByte,
                        mtime: new Date(asset.fileModifiedAt).getTime() / 1000, // Convert to seconds
                    };
                }
                return null; // Asset not found
            }

            default: {
                const _exhaustive: never = parsedPath;
                return _exhaustive;
            }
        }
    }

    //Create album and Upload files
    async mkdir(path: string): Promise<void> {
        // Only allow creation of folders at level 1 (e.g., "/MyAlbum")
        const cleanedPath = path.replace(/^\/+|\/+$/g, ""); // Remove leading and trailing slashes
        if (cleanedPath.includes("/")) {
            throw new Error("Only top-level folders (albums) can be created.");
        }

        // Create a new album in Immich
        await this.immichService.createAlbum(cleanedPath);
    }
    async writeFile(filename: string, tmpFile: tmp.FileResult): Promise<void> {
        this.uploadQueue.push({ filename, tmpFile });
    }
    async setAttributes(filename: string, mtime: number): Promise<void> {

        // Check if the file exists in the upload queue
        const fileEntry = this.uploadQueue.find(f => f.filename === filename);
        if (!fileEntry) {
            throw new Error(`File not found in upload queue: ${filename}`);
        }

        // Parse the path for the upload target
        const parsedPath = this.parsePath(filename);

        // Let the service handle the full upload finalization flow
        await this.immichService.uploadAssetToAlbum(parsedPath, filename, fileEntry.tmpFile, mtime);
    }
    async rename(oldName: string, newName: string): Promise<void> {
        // Check if the file exists in the upload queue
        const fileIndex = this.uploadQueue.findIndex(f => f.filename === oldName);

        //rename
        if (fileIndex !== -1) {
            this.uploadQueue[fileIndex].filename = newName;
            return; // Renaming in the upload queue is successful
        }

        //File not found
        throw new Error("Rename not support for Immich backend. Expect for tmp files (files that have been upload with OPEN, WRITE, CLOSE, but not jet sent to Immich in SETSTAT).");
    }

    //Delete files or albums
    async remove(filename: string): Promise<void> {

        // Determine if the path is an album or an asset
        const parsedPath = this.parsePath(filename);

        switch (parsedPath.kind) {
            case "album":
            case "tagAlbum": {
                const album = await this.immichService.getAlbumFromCache(parsedPath, false);
                await this.immichService.fetchAssetsForAlbum(album);

                //Delete all assets in the album
                for (const asset of album.assets ?? []) {
                    await this.immichService.deleteAsset(album, asset);
                }

                // Delete the album itself
                await this.immichService.deleteAlbum(album.id);
                return;
            }

            case "asset":
            case "tagAsset": {
                // Get the album and asset from the cache
                const album = await this.immichService.getAlbumFromCache(parsedPath, false);
                const asset = await this.immichService.getAssetFromCache(parsedPath, false);

                await this.immichService.deleteAsset(album, asset);
                return;
            }

            default:
                throw new Error(`Remove not supported for path: ${filename}`);
        }
    }

    //Helpers
    private findVirtualDirectory(path: string): string | null {
        const cleanedPath = path.replace(/^\/+|\/+$/g, "");

        if (cleanedPath === this.allAlbumsFolder) return this.allAlbumsFolder;
        if (cleanedPath === this.untaggedAlbumsFolder) return this.untaggedAlbumsFolder;
        if (cleanedPath === this.tagsFolder) return this.tagsFolder;
        if (cleanedPath === this.assetsWithoutAlbumFolder) return this.assetsWithoutAlbumFolder;

        return null;
    }
    private parsePath(filePath: string): ParsedPath {
        // Removes leading and trailing slashes, e.g. "//plants/..." -> "plants/..."
        const cleanedPath = filePath.replace(/^\/+|\/+$/g, "");
        const parts = cleanedPath.split('/').filter(Boolean); // Removes empty segments

        if (parts.length === 0) {
            return { kind: "root" };
        }

        if (parts[0] === this.tagsFolder) {
            if (parts.length === 1) {
                return {
                    kind: "virtualFolder",
                    virtualFolder: this.tagsFolder,
                };
            }
            if (parts.length === 2) {
                return {
                    kind: "tag",
                    tagName: parts[1],
                };
            }
            if (parts.length === 3) {
                return {
                    kind: "tagAlbum",
                    tagName: parts[1],
                    albumName: parts[2],
                };
            }
            if (parts.length === 4) {
                return {
                    kind: "tagAsset",
                    tagName: parts[1],
                    albumName: parts[2],
                    fileName: parts[3],
                };
            }

            throw new Error(`UngÃ¼ltiger Pfad: "${filePath}" â€“ Erwartet unter "${this.tagsFolder}" 1, 2, 3 oder 4 Segmente.`);
        }

        const virtualFolder = this.findVirtualDirectory(parts[0]);
        if (virtualFolder) {
            if (parts.length === 1) {
                return {
                    kind: "virtualFolder",
                    virtualFolder,
                };
            }
            if (parts.length === 2) {
                return {
                    kind: "album",
                    virtualFolder,
                    albumName: parts[1],
                };
            }
            if (parts.length === 3) {
                return {
                    kind: "asset",
                    virtualFolder,
                    albumName: parts[1],
                    fileName: parts[2],
                };
            }

            throw new Error(`UngÃ¼ltiger Pfad: "${filePath}" â€“ Erwartet unter "${virtualFolder}" 1, 2 oder 3 Segmente.`);
        }

        throw new Error(`UngÃ¼ltiger Pfad: "${filePath}"`);
    }
    private createDirEntry(name: string): { name: string; isDir: boolean; size: number; mtime: number } {
        return {
            name,
            isDir: true,
            size: 0,
            mtime: 0,
        };
    }

}
