export interface ImmichAlbum {
    id: string;
    albumName: string;
    description: string;
    assets?: ImmichAsset[];
}

export interface AlbumTag {
    name: string;
    albums: ImmichAlbum[];
}

export interface ImmichAsset {
    id: string;
    originalFileName: string;
    fileCreatedAt: string;
    fileModifiedAt: string;
    fileSizeInByte: number;
    isTrashed: boolean;
}

export type ParsedPath =
    | { kind: "root" }
    | { kind: "virtualFolder"; virtualFolder: string }
    | { kind: "tag"; tagName: string }
    | { kind: "assetWithoutAlbum"; fileName: string }
    | { kind: "album"; virtualFolder: string; albumName: string }
    | { kind: "asset"; virtualFolder: string; albumName: string; fileName: string }
    | { kind: "tagAlbum"; tagName: string; albumName: string }
    | { kind: "tagAsset"; tagName: string; albumName: string; fileName: string };
