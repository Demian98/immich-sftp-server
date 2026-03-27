import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import tmp from 'tmp';
import crypto from 'crypto';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { DateTime } from 'luxon';
import isValidFilename from 'valid-filename'; //Achtung, nicht auf v4.0.0 updaten. Ab da wird commjs projekt nicht mehr unterstÃ¼tzt, es geht dann nur noch als ES module.
import { config } from './config';
import { AlbumTag, ImmichAlbum, ImmichAsset, ParsedPath } from './immich-types';

export class ImmichService {

    // Remove trailing slashes from the Immich host URL
    private readonly baseUrl = config.immichHost.replace(/\/+$/, '');
    private immichAccessToken: string = '';
    private albumsCache: ImmichAlbum[] = [];
    private readonly tagPrefix: string = '#';


    //Session handling
    async login(username: string, password: string): Promise<void> {
        const loginResp = await this.immichRequest({
            method: 'POST',
            endpoint: 'auth/login',
            data: JSON.stringify({
                email: username,
                password: password,
            }),
            logAction: 'Login'
        });

        // Store the access token
        this.immichAccessToken = loginResp.accessToken;
    }
    async logout(): Promise<void> {
        await this.immichRequest({
            method: 'POST',
            endpoint: 'auth/logout',
            logAction: 'Logout'
        });
    }

    //Upload assets
    async uploadAssetToAlbum(parsedPath: ParsedPath, filename: string, tmpFile: tmp.FileResult, mtime: number): Promise<void> {
        // Calculate SHA-1 checksum of the buffer
        const hash = crypto.createHash('sha1');
        await pipeline(fs.createReadStream(tmpFile.name), hash);
        const checksum = hash.digest('base64');

        // Check if the asset already exists using bulk-upload-check
        const bulkCheckResponse = await this.bulkUploadCheck(filename, checksum);

        // Parse response
        const result = bulkCheckResponse.results[0];
        const action = result.action;
        let assetId = result.assetId;
        const isTrashed = result.isTrashed;
        const reason = result.reason;
        console.log(`Bulk check result for '${filename}': action=${action}, assetId=${assetId}, isTrashed=${isTrashed}, reason=${reason}`);
        
        // Get the album from the cache
        const album = await this.getAlbumFromCache(parsedPath, false);
        
        // If the asset doen't exist, upload it
        if (action == "accept") {

            const uploadResponse = await this.createAsset(filename, tmpFile.name, mtime, album.id);

            // Close tmp file after successful upload
            tmpFile.removeCallback();

            // Get the new asset id
            assetId = uploadResponse.id;
        }

        //Restore the asset if it is in the trash
        if (action == "reject" && isTrashed == true) {

            //Remove the trashed asset from other albums, in case it has some
            const assigedAlbums = await this.fetchAlbumsForAssetId(assetId);
            if (assigedAlbums && assigedAlbums.length > 0) {
                for (const assigedAlbum of assigedAlbums) {
                    await this.removeAssetFromAlbum(assigedAlbum, assetId);
                }
            }

            //Restore the asset from the trash
            await this.restoreAssets([assetId]);
        }

        // Add the new asset to the album
        await this.addAssetToAlbum(album.id, assetId);
    }
    private async bulkUploadCheck(filename: string, checksum: string): Promise<any> {
        return await this.immichRequest({
            method: 'POST',
            endpoint: 'assets/bulk-upload-check',
            data: JSON.stringify({
                assets: [
                    {
                        checksum: checksum,
                        id: filename,
                    }
                ]
            }),
            logAction: 'Bulk upload check'
        });
    }
    private async createAsset(filename: string, tmpFilePath: string, mtime: number, albumId: string): Promise<any> {
        // Prepare form data
        const data = new FormData();
        const isoWithOffset = DateTime.fromSeconds(mtime, { zone: config.TZ }).toISO();
        data.append('fileModifiedAt', isoWithOffset);
        data.append('fileCreatedAt', isoWithOffset);
        data.append('deviceAssetId', filename); // Use fileName as deviceAssetId
        data.append('deviceId', 'immich-sftp-server');
        data.append('albumId', albumId);

        // Add stream from tmp file
        const readStream = fs.createReadStream(tmpFilePath);
        data.append('assetData', readStream, { filename: filename });

        // Send the upload request to Immich
        return await this.immichRequest({
            method: 'POST',
            endpoint: 'assets',
            data: data,
            logAction: 'Upload asset'
        });
    }
    private async addAssetToAlbum(albumId: string, assetId: string): Promise<void> {
        await this.immichRequest({
            method: 'PUT',
            endpoint: `albums/${albumId}/assets`,
            data: JSON.stringify({
                ids: [assetId]
            }),
            logAction: 'Add asset to album'
        });
    }

    //Download assets
    async downloadAsset(assetId: string): Promise<Readable> {
        return await this.immichRequest({
            method: 'GET',
            endpoint: `assets/${assetId}/original`,
            logAction: 'Download asset',
            respAsStream: true
        });
    }

    //Get Albums
    async getAllAlbums(refreshCache: boolean): Promise<ImmichAlbum[]> {
        if (this.albumsCache.length === 0 || refreshCache) {
            this.albumsCache = await this.fetchAlbums();
        }

        return this.albumsCache;
    }
    async getUntaggedAlbums(refreshCache: boolean): Promise<ImmichAlbum[]> {
        //Get all albums from Immich API
        const albums = await this.getAllAlbums(refreshCache);

        //Find all albums that don't have the tag prefix in their description
        return albums.filter(album => !(album.description ?? "").includes(this.tagPrefix));
    }
    private async fetchAlbums(): Promise<ImmichAlbum[]> {

        //Parameter "shaerd":
        // - not set: All albums owned by me, also when shared with other users
        // - false: only own albums, that are not shared with other users
        // - true: only shared albums, own and from other users shared with me

        // Fetch albums from Immich API
        const response = await this.immichRequest({
            method: 'GET',
            endpoint: 'albums',
            logAction: 'All own albums',
            skipResponseLog: true,
        });

        //Process and filter albums
        return this.filterAlbums(response);
    }
    async getAlbumFromCache(parsedPath: ParsedPath, refreshCache: boolean): Promise<ImmichAlbum> {
        const album = await this.getAlbumOrNullFromCache(parsedPath, refreshCache);
        if (!album) {
            throw new Error(`Album not found for path: ${JSON.stringify(parsedPath)}`);
        }

        return album;
    }
    async getAlbumWithAssets(parsedPath: ParsedPath, refreshAssetsForThisAlbum: boolean): Promise<ImmichAlbum> {
        //Get the album from the cache
        const album = await this.getAlbumFromCache(parsedPath, false);

        // If the album has no assets, fetch them
        if ((album.assets?.length ?? 0) === 0 || refreshAssetsForThisAlbum) {
            await this.fetchAssetsForAlbum(album);
        }

        return album;
    }
    async getAlbumOrNullFromCache(parsedPath: ParsedPath, refreshCache: boolean): Promise<ImmichAlbum | null> {
        // If albums are not cached, fetch them
        if (this.albumsCache.length === 0 || refreshCache) {
            this.albumsCache = await this.fetchAlbums();
        }

        // Find the album based on the parsed path
        switch (parsedPath.kind) {
            case "album":
            case "asset":
            case "tagAlbum":
            case "tagAsset":
                return this.albumsCache.find(a => a.albumName === parsedPath.albumName) || null;
            default:
                return null;
        }
    }
    private filterAlbums(response: any) {
        // Map response to ImmichAlbum objects
        const albums: ImmichAlbum[] = response.map((item: any): ImmichAlbum => ({
            id: item.id,
            albumName: item.albumName,
            description: item.description,
        }));

        //todo replace this method by filterFolderNames

        // Filter out albums with empty or invalid names
        let filteredAlbums = albums.filter(album => isValidFilename(album.albumName));

        // Filter out duplicate album names (case-insensitive)
        const seenNames = new Set<string>();
        filteredAlbums = filteredAlbums.filter(album => {
            const lowerName = album.albumName.toLowerCase();
            if (seenNames.has(lowerName)) return false;
            seenNames.add(lowerName);
            return true;
        });

        //Return filtered albums
        return filteredAlbums;
    }
    private async fetchAlbumsForAssetId(assetId: string): Promise<ImmichAlbum[]> {
        // Check in which albums the asset is used
        const response = await this.immichRequest({
            method: 'GET',
            endpoint: `albums?assetId=${assetId}`,
            logAction: 'Albums for assetId',
            skipResponseLog: true,
        });

        //Process and filter albums
        return this.filterAlbums(response);
    }

    //Maintain albums
    private async restoreAssets(assetIds: string[]): Promise<void> {
        await this.immichRequest({
            method: 'POST',
            endpoint: 'trash/restore/assets',
            data: JSON.stringify({ ids: assetIds }),
            logAction: 'Restore asset'
        });
    }
    async deleteAlbum(albumId: string): Promise<void> {
        await this.immichRequest({
            method: 'DELETE',
            endpoint: `albums/${albumId}`,
            logAction: 'Delete album'
        });
    }
    async createAlbum(albumName: string): Promise<void> {
        await this.immichRequest({
            method: 'POST',
            endpoint: 'albums',
            data: JSON.stringify({ albumName: albumName }),
            logAction: 'Create album'
        });
    }

    //Get Assets
    async getAssetFromCache(parsedPath: ParsedPath, refreshAssetsForThisAlbum: boolean): Promise<ImmichAsset> {
        const asset = await this.getAssetOrNullFromCache(parsedPath, refreshAssetsForThisAlbum);
        if (asset) {
            return asset;
        }
        throw new Error(`Asset not found for path: ${JSON.stringify(parsedPath)}`);
    }
    async getAssetOrNullFromCache(parsedPath: ParsedPath, refreshAssetsForThisAlbum: boolean): Promise<ImmichAsset | null> {
        //Get the album from the cache
        const album = await this.getAlbumWithAssets(parsedPath, refreshAssetsForThisAlbum);

        // Find the asset in the album based on the original file name
        switch (parsedPath.kind) {
            case "asset":
            case "tagAsset":
                return album.assets?.find(a => a.originalFileName === parsedPath.fileName) || null;
            default:
                return null;
        }
    }
    private async fetchAssetsForAlbum(album: ImmichAlbum): Promise<void> {
        // Fetch assets
        const response = await this.immichRequest({
            method: 'GET',
            endpoint: `albums/${album.id}`,
            logAction: 'Assets in album',
            skipResponseLog: true,
        });

        // Convert to ImmichAsset
        album.assets = response.assets.map((asset: any): ImmichAsset => {

            if (!asset.exifInfo?.fileSizeInByte) {
                console.warn(`Asset ${asset.originalFileName} (${asset.id}) has no exifInfo.fileSizeInByte, using 0 as fallback.`);
            }

            return {
                id: asset.id,
                originalFileName: asset.originalFileName,
                fileCreatedAt: asset.fileCreatedAt,
                fileModifiedAt: asset.fileModifiedAt,
                fileSizeInByte: asset.exifInfo?.fileSizeInByte ?? 0,
                isTrashed: asset.isTrashed,
            }
        });
    }

    //Maintain assets
    private async removeAssetFromAlbum(album: ImmichAlbum, assetId: string): Promise<void> {
        // Remove asset from album
        await this.immichRequest({
            method: 'DELETE',
            endpoint: `albums/${album.id}/assets`,
            data: JSON.stringify({ ids: [assetId] }),
            logAction: 'Remove asset from album'
        });
    }
    async deleteAsset(album: ImmichAlbum, asset: ImmichAsset): Promise<void> {
        // Check in which albums the asset is used
        const albumsForAsset = await this.fetchAlbumsForAssetId(asset.id);

        // If the asset is in other albums
        if (albumsForAsset && albumsForAsset.length > 1) {

            // Remove asset from album
            await this.removeAssetFromAlbum(album, asset.id);
        }
        else {
            // Asset is used in only 1 or no album, delete it from Immich
            await this.immichRequest({
                method: 'DELETE',
                endpoint: 'assets',
                data: JSON.stringify({ ids: [asset.id] }),
                logAction: 'Delete asset'
            });
        }
    }

    //Get Tags
    async getAllTags(refreshCache: boolean): Promise<AlbumTag[]> {
        return await this.getAllTagsFromCache(refreshCache);
    }
    async getAlbumsForTag(parsedPath: ParsedPath, refreshCache: boolean): Promise<ImmichAlbum[]> {
        //Get tag from cache
        const tag = await this.getTagFromCache(parsedPath, refreshCache);

        //Map albums to the expected format
        return tag.albums;
    }
    private async getAllTagsFromCache(refreshCache: boolean): Promise<AlbumTag[]> {
        //Todo implement cache refresh

        //Get all albums from Immich API
        this.albumsCache = await this.fetchAlbums();

        //Find all tags in the album descriptions
        const tags = new Array<AlbumTag>();
        this.albumsCache.forEach((album) => {
            const description = album.description ?? "";

            // (\\S+) means "match one or more non-whitespace characters and capture them as a group".
            // "g" means "global search", so it will find all matches in the description, not just the first one.
            const regex = new RegExp(`${this.tagPrefix}(\\S+)`, "g");

            let match: RegExpExecArray | null;
            while ((match = regex.exec(description)) !== null) {
                // nur Tagname, ohne Prefix
                const tagName = match[1];

                //Find or create tag
                let tag = tags.find(t => t.name === tagName);
                if (!tag) {
                    tag = { name: tagName, albums: [] };
                    tags.push(tag);
                }

                //Add current album to the tag
                tag.albums.push(album);
            }
        });

        //Remove invalid or duplicate names
        const filteredTags = this.filterTags(tags);

        //Build map
        return filteredTags;
    }
    private async getTagFromCache(parsedPath: ParsedPath, refreshCache: boolean): Promise<AlbumTag> {
        const tag = await this.getTagOrNullFromCache(parsedPath, refreshCache);
        if (!tag) {
            throw new Error(`Tag not found for path: ${JSON.stringify(parsedPath)}`);
        }

        return tag;
    }
    private async getTagOrNullFromCache(parsedPath: ParsedPath, refreshCache: boolean): Promise<AlbumTag | null> {
        // If albums are not cached, fetch them
        if (this.albumsCache.length === 0 || refreshCache) {
            this.albumsCache = await this.fetchAlbums();
        }

        // Find the tag based on the parsed path
        if (parsedPath.kind !== "tag" && parsedPath.kind !== "tagAlbum" && parsedPath.kind !== "tagAsset") {
            return null;
        }

        const tags = await this.getAllTagsFromCache(false);
        return tags.find(t => t.name === parsedPath.tagName) || null;
    }
    private filterTags(tags: Array<AlbumTag>): Array<AlbumTag> {
        // Filter out albums with empty or invalid names
        let filteredTags = tags.filter(tag => isValidFilename(tag.name));

        // Filter out duplicate album names (case-insensitive)
        const seenNames = new Set<string>();
        filteredTags = filteredTags.filter(tag => {
            const lowerName = tag.name.toLowerCase();
            if (seenNames.has(lowerName)) return false;
            seenNames.add(lowerName);
            return true;
        });

        //Return filtered albums
        return filteredTags;
    }


    //Execute requests
    private async immichRequest({ method, endpoint, data, logAction, respAsStream = false, skipResponseLog = false }: { method: 'GET' | 'POST' | 'PUT' | 'DELETE', endpoint: string, data?: any, logAction: string, respAsStream?: boolean, skipResponseLog?: boolean }): Promise<any> {
        try {
            console.log(`Sending (${logAction}): ${method} /api/${endpoint}`, this.filterLogData(data));

            const isDownload = method === 'GET' && endpoint.startsWith('assets/') && endpoint.endsWith('/original');

            const response = await axios.request({
                method: method,
                url: `${this.baseUrl}/api/${endpoint}`,
                headers: {
                    ...(isDownload ? {} : { 'Accept': 'application/json' }),
                    'User-Agent': 'ImmichSFTP (Linux)',
                    'Authorization': `Bearer ${this.immichAccessToken}`,
                    ...(data instanceof FormData ? data.getHeaders?.() : { 'Content-Type': 'application/json' }),
                },
                data: data ?? undefined,

                // stream = Streaming requested for download
                // arraybuffer = Download requested without streaming
                // json = Default for all other requests
                responseType: respAsStream ? 'stream' : (isDownload ? 'arraybuffer' : 'json'),
            });

            //Todo better implementation of logging
            if (skipResponseLog == true) {
                console.log(`Received (${logAction}):`, response.status, '[Data skipped]');
            }
            else {
                console.log(`Received (${logAction}):`, response.status, this.filterLogData(response.data));
            }
            return response.data;
        } catch (restoreError) {
            if (axios.isAxiosError(restoreError)) {
                console.error(`Axios error (${logAction}):`, restoreError.response?.data || restoreError.message);
            } else {
                console.error(`Unknown error during http request (${logAction}):`, restoreError);
            }
            throw restoreError;
        }
    }
    private filterLogData(data: any): any {
        // Filter sensitive data from the log
        if (Buffer.isBuffer(data)) {
            return '[Binary Data]'; // Mask the binary data as '[Binary Data]'
        }
        if (data instanceof Blob) {
            return '[Blob]';  // For browsers, you can handle Blobs
        }
        // Hide FormData contents
        if (data instanceof FormData) {
            return '[FormData]';
        }
        // Handle edge cases where the data might be large and contain binary-like strings.
        if (typeof data === 'string' && /[^\x00-\x7F]/.test(data)) {
            return '[Non-ASCII Text]'; // Mask non-ASCII content as non-readable text
        }
        return data; // Return as is if not an object
    }
}
