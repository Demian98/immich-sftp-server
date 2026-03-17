import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import { Readable } from 'stream';
import { config } from './config';

export interface ImmichAlbum {
  id: string;
  albumName: string;
  description: string;
  assets?: ImmichAsset[];
}

export interface ImmichAsset {
  id: string;
  originalFileName: string;
  fileCreatedAt: string;
  fileModifiedAt: string;
  fileSizeInByte: number;
  isTrashed: boolean;
}

export class ImmichService {
  private immichAccessToken = '';
  private readonly baseUrl = config.immichHost.replace(/\/+$/, '');

  async login(username: string, password: string): Promise<void> {
    const response = await this.immichRequest({
      method: 'POST',
      endpoint: 'auth/login',
      data: JSON.stringify({
        email: username,
        password,
      }),
      logAction: 'Login',
    });

    this.immichAccessToken = response.accessToken;
  }

  async logout(): Promise<void> {
    await this.immichRequest({
      method: 'POST',
      endpoint: 'auth/logout',
      logAction: 'Logout',
    });
  }

  async fetchAlbums(): Promise<ImmichAlbum[]> {
    const response = await this.immichRequest({
      method: 'GET',
      endpoint: 'albums',
      logAction: 'All own albums',
      skipResponseLog: true,
    });

    return response.map((item: any): ImmichAlbum => ({
      id: item.id,
      albumName: item.albumName,
      description: item.description,
    }));
  }

  async fetchAlbumsForAssetId(assetId: string): Promise<ImmichAlbum[]> {
    const response = await this.immichRequest({
      method: 'GET',
      endpoint: `albums?assetId=${assetId}`,
      logAction: 'Albums for assetId',
      skipResponseLog: true,
    });

    return response.map((item: any): ImmichAlbum => ({
      id: item.id,
      albumName: item.albumName,
      description: item.description,
    }));
  }

  async fetchAssetsForAlbum(albumId: string): Promise<ImmichAsset[]> {
    const response = await this.immichRequest({
      method: 'GET',
      endpoint: `albums/${albumId}`,
      logAction: 'Assets in album',
      skipResponseLog: true,
    });

    return response.assets.map((asset: any): ImmichAsset => ({
      id: asset.id,
      originalFileName: asset.originalFileName,
      fileCreatedAt: asset.fileCreatedAt,
      fileModifiedAt: asset.fileModifiedAt,
      fileSizeInByte: asset.exifInfo?.fileSizeInByte ?? 0,
      isTrashed: asset.isTrashed,
    }));
  }

  async downloadAsset(assetId: string): Promise<Readable> {
    return this.immichRequest({
      method: 'GET',
      endpoint: `assets/${assetId}/original`,
      logAction: 'Download asset',
      respAsStream: true,
    });
  }

  async bulkUploadCheck(filename: string, checksum: string): Promise<any> {
    return this.immichRequest({
      method: 'POST',
      endpoint: 'assets/bulk-upload-check',
      data: JSON.stringify({
        assets: [
          {
            checksum,
            id: filename,
          },
        ],
      }),
      logAction: 'Bulk upload check',
    });
  }

  async uploadAsset(filePath: string, fileName: string, albumId: string, mtimeIso: string): Promise<{ id: string }> {
    const data = new FormData();
    data.append('fileModifiedAt', mtimeIso);
    data.append('fileCreatedAt', mtimeIso);
    data.append('deviceAssetId', fileName);
    data.append('deviceId', 'immich-sftp-server');
    data.append('albumId', albumId);
    data.append('assetData', fs.createReadStream(filePath), { filename: fileName });

    return this.immichRequest({
      method: 'POST',
      endpoint: 'assets',
      data,
      logAction: 'Upload asset',
    });
  }

  async restoreAssets(assetIds: string[]): Promise<void> {
    await this.immichRequest({
      method: 'POST',
      endpoint: 'trash/restore/assets',
      data: JSON.stringify({ ids: assetIds }),
      logAction: 'Restore asset',
    });
  }

  async addAssetsToAlbum(albumId: string, assetIds: string[]): Promise<void> {
    await this.immichRequest({
      method: 'PUT',
      endpoint: `albums/${albumId}/assets`,
      data: JSON.stringify({ ids: assetIds }),
      logAction: 'Add asset to album',
    });
  }

  async removeAssetsFromAlbum(albumId: string, assetIds: string[]): Promise<void> {
    await this.immichRequest({
      method: 'DELETE',
      endpoint: `albums/${albumId}/assets`,
      data: JSON.stringify({ ids: assetIds }),
      logAction: 'Remove asset from album',
    });
  }

  async deleteAssets(assetIds: string[]): Promise<void> {
    await this.immichRequest({
      method: 'DELETE',
      endpoint: 'assets',
      data: JSON.stringify({ ids: assetIds }),
      logAction: 'Delete asset',
    });
  }

  async createAlbum(albumName: string): Promise<void> {
    await this.immichRequest({
      method: 'POST',
      endpoint: 'albums',
      data: JSON.stringify({ albumName }),
      logAction: 'Create album',
    });
  }

  async deleteAlbum(albumId: string): Promise<void> {
    await this.immichRequest({
      method: 'DELETE',
      endpoint: `albums/${albumId}`,
      logAction: 'Delete album',
    });
  }

  private async immichRequest({ method, endpoint, data, logAction, respAsStream = false, skipResponseLog = false }: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; endpoint: string; data?: any; logAction: string; respAsStream?: boolean; skipResponseLog?: boolean }): Promise<any> {
    try {
      console.log(`Sending (${logAction}): ${method} /api/${endpoint}`, this.filterLogData(data));

      const isDownload = method === 'GET' && endpoint.startsWith('assets/') && endpoint.endsWith('/original');

      const response = await axios.request({
        method,
        url: `${this.baseUrl}/api/${endpoint}`,
        headers: {
          ...(isDownload ? {} : { Accept: 'application/json' }),
          'User-Agent': 'ImmichSFTP (Linux)',
          Authorization: `Bearer ${this.immichAccessToken}`,
          ...(data instanceof FormData ? data.getHeaders?.() : { 'Content-Type': 'application/json' }),
        },
        data: data ?? undefined,
        responseType: respAsStream ? 'stream' : (isDownload ? 'arraybuffer' : 'json'),
      });

      if (skipResponseLog) {
        console.log(`Received (${logAction}):`, response.status, '[Data skipped]');
      } else {
        console.log(`Received (${logAction}):`, response.status, this.filterLogData(response.data));
      }

      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        console.error(`Axios error (${logAction}):`, error.response?.data || error.message);
      } else {
        console.error(`Unknown error during http request (${logAction}):`, error);
      }
      throw error;
    }
  }

  private filterLogData(data: any): any {
    if (Buffer.isBuffer(data)) return '[Binary Data]';
    if (data instanceof Blob) return '[Blob]';
    if (data instanceof FormData) return '[FormData]';
    if (typeof data === 'string' && /[^\x00-\x7F]/.test(data)) return '[Non-ASCII Text]';
    return data;
  }
}
