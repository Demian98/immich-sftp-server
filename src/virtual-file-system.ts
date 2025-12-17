import tmp from 'tmp';

// Interface: VirtualFileSystem
export interface VirtualFileSystem {
    setAttributes(filename: string, mtime: number): Promise<void>;
    listFiles(currentDir: string): Promise<Array<{ name: string; isDir: boolean; size: number; mtime: number }>>;
    readFile(filename: string): Promise<tmp.FileResult>;
    writeFile(filename: string, tmpFile: tmp.FileResult): Promise<void>;
    stat(filename: string): Promise<{ isDir: boolean; size: number; mtime: number } | null>;
    rename(oldName: string, newName: string): Promise<void>;
    remove(filename: string): Promise<void>;
    mkdir(path: string): Promise<void>;

    login(username: string, password: string): Promise<void>;
    logout(): Promise<void>;
}