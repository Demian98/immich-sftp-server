import { VirtualFileSystem } from "./virtual-file-system";
import fs from 'fs';
import tmp from 'tmp';


// JSON-basiertes VirtualFileSystem-Backend
export class JsonFileSystem implements VirtualFileSystem {

  jsonPath: string;
  entries: any[];

  constructor(jsonPath: string) {
    this.jsonPath = jsonPath;
    this.entries = this._load();
  }

  _load() {
    const raw = fs.readFileSync(this.jsonPath, 'utf8');
    return JSON.parse(raw).entries || [];
  }

  _save() {
    fs.writeFileSync(this.jsonPath, JSON.stringify({ entries: this.entries }, null, 2));
  }

  async listFiles(currentDir: string) {
    const entriesMap = new Map();

    for (const entry of this.entries) {
      const parts = entry.name.split('/');
      const dir = parts.slice(0, -1).join('/') || '/';
      const name = parts[parts.length - 1];

      if (dir !== currentDir) continue;

      entriesMap.set(name, {
        name,
        isDir: entry.type === 'dir',
        size: entry.type === 'file' ? Buffer.from(entry.contentBase64, 'base64').length : 0,
        mtime: new Date(entry.modified).getTime() / 1000
      });
    }

    return [...entriesMap.values()];
  }

  async readFile(filename: string) {
    const file = this.entries.find(f => f.type === 'file' && f.name === filename);
    if (!file) throw new Error('File not found');

    const buffer = Buffer.from(file.contentBase64, 'base64');
    const tmpFile = tmp.fileSync();
    fs.writeFileSync(tmpFile.name, buffer);
    return tmpFile;
  }

  async writeFile(filename: string, tmpFile: tmp.FileResult) {
    let file = this.entries.find(f => f.type === 'file' && f.name === filename);

    if (!file) {
      file = {
        name: filename,
        type: 'file',
        contentBase64: '',
        modified: new Date().toISOString()
      };
      this.entries.push(file);
    }

    const fileBuffer = fs.readFileSync(tmpFile.name);
    file.contentBase64 = fileBuffer.toString('base64');
    file.modified = new Date().toISOString();
    this._save();

    // Clean up the temporary file
    tmpFile.removeCallback(); 
  }

  async stat(filename: string) {
    const entry = this.entries.find(e => e.name === filename);
    if (!entry) return null;

    return {
      isDir: entry.type === 'dir',
      size: entry.type === 'file' ? Buffer.from(entry.contentBase64, 'base64').length : 0,
      mtime: new Date(entry.modified).getTime() / 1000
    };
  }

  async setAttributes(filename: string, mtime: number) {
    const file = this.entries.find(f => f.name === filename);
    if (!file) throw new Error('File not found');

    if (mtime) file.modified = new Date(mtime * 1000).toISOString();

    this._save();
  }

  async rename(oldName: string, newName: string) {
    const entry = this.entries.find(e => e.name === oldName);
    if (!entry) throw new Error('Not found');
    if (this.entries.find(e => e.name === newName)) throw new Error('Target exists');

    if (entry.type === 'dir') {
      for (const e of this.entries) {
        if (e.name === oldName || e.name.startsWith(oldName + '/')) {
          e.name = e.name.replace(oldName, newName);
          e.modified = new Date().toISOString();
        }
      }
    } else {
      entry.name = newName;
      entry.modified = new Date().toISOString();
    }

    this._save();
  }

  async remove(path: string) {
    const index = this.entries.findIndex(e => e.name === path);
    if (index === -1) throw new Error('Not found');
    const entry = this.entries[index];

    if (entry.type === 'dir') {
      const hasChildren = this.entries.some(e => e.name.startsWith(path + '/'));
      if (hasChildren) throw new Error('Directory not empty');
    }

    this.entries.splice(index, 1);
    this._save();
  }

  async mkdir(path: string) {
    const exists = this.entries.some(e => e.name === path);
    if (exists) throw new Error('Directory already exists');

    this.entries.push({
      name: path,
      type: 'dir',
      modified: new Date().toISOString()
    });

    this._save();
  }

  async login(username: string, password: string): Promise<void> {
    // No Authentication in the json file system
    return;
  }
  async logout(): Promise<void> {
    // No Authentication in the json file system
    return;
  }

}