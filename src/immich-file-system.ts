import { VirtualFileSystem } from "./virtual-file-system";
import crypto from 'crypto';
import { config } from './config';
import fs from 'fs';
import tmp from 'tmp';
import { pipeline } from 'stream/promises';
import { DateTime } from 'luxon';
import isValidFilename from 'valid-filename';
import { ImmichAlbum, ImmichAsset, ImmichService } from './immich-service';

export class ImmichFileSystem implements VirtualFileSystem {
  private readonly immichService = new ImmichService();
  private albumsCache: ImmichAlbum[] = [];
  private uploadQueue: Array<{ filename: string; tmpFile: tmp.FileResult }> = [];

  private readonly allAlbumsFolder = 'all albums';
  private readonly untaggedAlbumsFolder = 'untagged albums';
  private readonly tagsFolder = 'tags';
  private readonly assetsWithoutAlbumFolder = 'assets without album';

  async login(username: string, password: string): Promise<void> {
    await this.immichService.login(username, password);
  }

  async logout(): Promise<void> {
    await this.immichService.logout();
  }

  async setAttributes(filename: string, mtime: number): Promise<void> {
    const fileEntry = this.uploadQueue.find((f) => f.filename === filename);
    if (!fileEntry) {
      throw new Error(`File not found in upload queue: ${filename}`);
    }

    const album = await this.getAlbumFromCache(filename, false);

    const hash = crypto.createHash('sha1');
    await pipeline(fs.createReadStream(fileEntry.tmpFile.name), hash);
    const checksum = hash.digest('base64');

    const bulkCheckResponse = await this.immichService.bulkUploadCheck(filename, checksum);
    const result = bulkCheckResponse.results[0];
    const action = result.action;
    let assetId = result.assetId;
    const isTrashed = result.isTrashed;

    if (action === 'accept') {
      const isoWithOffset = DateTime.fromSeconds(mtime, { zone: config.TZ }).toISO();
      const uploadResponse = await this.immichService.uploadAsset(fileEntry.tmpFile.name, filename, album.id, isoWithOffset);

      fileEntry.tmpFile.removeCallback();
      assetId = uploadResponse.id;
    }

    if (action === 'reject' && isTrashed === true) {
      const assignedAlbums = await this.fetchAlbumsForAssetId(assetId);
      for (const assignedAlbum of assignedAlbums) {
        await this.immichService.removeAssetsFromAlbum(assignedAlbum.id, [assetId]);
      }

      await this.immichService.restoreAssets([assetId]);
    }

    await this.immichService.addAssetsToAlbum(album.id, [assetId]);
  }

  async listFiles(currentDir: string): Promise<Array<{ name: string; isDir: boolean; size: number; mtime: number }>> {
    if (currentDir === '/') {
      return [
        this.createDirEntry(this.allAlbumsFolder),
        this.createDirEntry(this.untaggedAlbumsFolder),
        this.createDirEntry(this.tagsFolder),
        this.createDirEntry(this.assetsWithoutAlbumFolder),
      ];
    }

    if (this.isVirtualDirectory(currentDir)) {
      if (this.isAlbumsRootPath(currentDir)) {
        this.albumsCache = await this.fetchAlbums();
        return this.albumsCache.map((album) => this.createDirEntry(album.albumName));
      }

      // Placeholder folders for next phases.
      return [];
    }

    const album = await this.getAlbumFromCache(currentDir, false);
    await this.fetchAssetsForAlbum(album);

    return (album.assets ?? []).map((asset) => ({
      name: asset.originalFileName,
      isDir: false,
      size: asset.fileSizeInByte,
      mtime: new Date(asset.fileModifiedAt).getTime() / 1000,
    }));
  }

  async readFile(filename: string): Promise<tmp.FileResult> {
    const asset = await this.getAssetFromCache(filename, false);
    const responseStream = await this.immichService.downloadAsset(asset.id);

    const tmpFile = tmp.fileSync();
    const writeStream = fs.createWriteStream(tmpFile.name);
    await pipeline(responseStream, writeStream);

    return tmpFile;
  }

  async writeFile(filename: string, tmpFile: tmp.FileResult): Promise<void> {
    this.uploadQueue.push({ filename, tmpFile });
  }

  async stat(filename: string): Promise<{ isDir: boolean; size: number; mtime: number } | null> {
    if (filename === '/' || this.isVirtualDirectory(filename)) {
      return {
        isDir: true,
        size: 0,
        mtime: 0,
      };
    }

    const pathInfo = this.extractPathInfo(filename);

    if (pathInfo.fileName === null) {
      const album = await this.getAlbumOrNullFromCache(filename, true);
      if (!album) {
        return null;
      }

      return {
        isDir: true,
        size: 0,
        mtime: 0,
      };
    }

    const asset = await this.getAssetOrNullFromCache(filename, true);
    if (!asset) {
      return null;
    }

    return {
      isDir: false,
      size: asset.fileSizeInByte,
      mtime: new Date(asset.fileModifiedAt).getTime() / 1000,
    };
  }

  async rename(oldName: string, newName: string): Promise<void> {
    const fileIndex = this.uploadQueue.findIndex((f) => f.filename === oldName);

    if (fileIndex !== -1) {
      this.uploadQueue[fileIndex].filename = newName;
      return;
    }

    throw new Error('Rename not support for Immich backend. Expect for tmp files (files that have been upload with OPEN, WRITE, CLOSE, but not jet sent to Immich in SETSTAT).');
  }

  async remove(filename: string): Promise<void> {
    const pathInfo = this.extractPathInfo(filename);

    if (pathInfo.albumName !== null && pathInfo.fileName === null) {
      const album = await this.getAlbumFromCache(filename, false);
      await this.fetchAssetsForAlbum(album);

      for (const asset of album.assets ?? []) {
        await this.deleteAsset(album, asset);
      }

      await this.immichService.deleteAlbum(album.id);
      return;
    }

    if (pathInfo.albumName !== null && pathInfo.fileName !== null) {
      const album = await this.getAlbumFromCache(filename, false);
      const asset = await this.getAssetFromCache(filename, false);
      await this.deleteAsset(album, asset);
    }
  }

  async mkdir(path: string): Promise<void> {
    const cleanedPath = path.replace(/^\/+|\/+$/g, '');
    const parts = cleanedPath.split('/').filter(Boolean);
    const isValidCreatePath = parts.length === 2 && (parts[0] === this.allAlbumsFolder || parts[0] === this.untaggedAlbumsFolder);

    if (!isValidCreatePath) {
      throw new Error(`Albums can only be created in '/${this.allAlbumsFolder}' or '/${this.untaggedAlbumsFolder}'.`);
    }

    await this.immichService.createAlbum(parts[1]);
  }

  private async fetchAlbums(): Promise<ImmichAlbum[]> {
    const albums = await this.immichService.fetchAlbums();
    return this.filterAlbums(albums);
  }

  private async fetchAlbumsForAssetId(assetId: string): Promise<ImmichAlbum[]> {
    const albums = await this.immichService.fetchAlbumsForAssetId(assetId);
    return this.filterAlbums(albums);
  }

  private async fetchAssetsForAlbum(album: ImmichAlbum): Promise<void> {
    album.assets = await this.immichService.fetchAssetsForAlbum(album.id);
  }

  private filterAlbums(albums: ImmichAlbum[]): ImmichAlbum[] {
    let filteredAlbums = albums.filter((album) => isValidFilename(album.albumName));

    const seenNames = new Set<string>();
    filteredAlbums = filteredAlbums.filter((album) => {
      const lowerName = album.albumName.toLowerCase();
      if (seenNames.has(lowerName)) return false;
      seenNames.add(lowerName);
      return true;
    });

    return filteredAlbums;
  }

  private extractPathInfo(filePath: string): { albumName: string | null; fileName: string | null } {
    const cleanedPath = filePath.replace(/^\/+|\/+$/g, '');
    const parts = cleanedPath.split('/').filter(Boolean);

    if (parts[0] === this.allAlbumsFolder || parts[0] === this.untaggedAlbumsFolder) {
      if (parts.length === 2) {
        return {
          albumName: parts[1],
          fileName: null,
        };
      }

      if (parts.length === 3) {
        return {
          albumName: parts[1],
          fileName: parts[2],
        };
      }
    }

    throw new Error(`Invalid path: "${filePath}". Expected '/${this.allAlbumsFolder}/<album>' or '/${this.allAlbumsFolder}/<album>/<file>'.`);
  }

  private isVirtualDirectory(path: string): boolean {
    const cleanedPath = path.replace(/^\/+|\/+$/g, '');

    if (cleanedPath === '') return false;
    if (cleanedPath === this.allAlbumsFolder) return true;
    if (cleanedPath === this.untaggedAlbumsFolder) return true;
    if (cleanedPath === this.tagsFolder) return true;
    if (cleanedPath === this.assetsWithoutAlbumFolder) return true;

    return false;
  }

  private isAlbumsRootPath(path: string): boolean {
    const cleanedPath = path.replace(/^\/+|\/+$/g, '');
    return cleanedPath === this.allAlbumsFolder || cleanedPath === this.untaggedAlbumsFolder;
  }

  private createDirEntry(name: string): { name: string; isDir: boolean; size: number; mtime: number } {
    return {
      name,
      isDir: true,
      size: 0,
      mtime: 0,
    };
  }

  private async getAlbumFromCache(filename: string, refreshCache: boolean): Promise<ImmichAlbum> {
    const album = await this.getAlbumOrNullFromCache(filename, refreshCache);
    if (!album) {
      throw new Error(`Album not found for filename: ${filename}`);
    }

    return album;
  }

  private async getAlbumOrNullFromCache(filename: string, refreshCache: boolean): Promise<ImmichAlbum | null> {
    if (this.albumsCache.length === 0 || refreshCache) {
      this.albumsCache = await this.fetchAlbums();
    }

    const folderName = this.extractPathInfo(filename).albumName;
    return this.albumsCache.find((album) => album.albumName === folderName) || null;
  }

  private async getAssetFromCache(filename: string, refreshAssetsForThisAlbum: boolean): Promise<ImmichAsset> {
    const asset = await this.getAssetOrNullFromCache(filename, refreshAssetsForThisAlbum);
    if (asset) {
      return asset;
    }

    throw new Error(`Asset not found for filename: ${filename}`);
  }

  private async getAssetOrNullFromCache(filename: string, refreshAssetsForThisAlbum: boolean): Promise<ImmichAsset | null> {
    const album = await this.getAlbumOrNullFromCache(filename, false);
    if (!album) return null;

    if ((album.assets?.length ?? 0) === 0 || refreshAssetsForThisAlbum) {
      await this.fetchAssetsForAlbum(album);
    }

    const assetFileName = this.extractPathInfo(filename).fileName;
    return album.assets?.find((asset) => asset.originalFileName === assetFileName) || null;
  }

  private async deleteAsset(album: ImmichAlbum, asset: ImmichAsset): Promise<void> {
    const albumsForAsset = await this.fetchAlbumsForAssetId(asset.id);

    if (albumsForAsset.length > 1) {
      await this.immichService.removeAssetsFromAlbum(album.id, [asset.id]);
    } else {
      await this.immichService.deleteAssets([asset.id]);
    }
  }
}
