declare module "heic-decode" {
  interface DecodeResult {
    width: number;
    height: number;
    /** RGBA pixel data, 4 channels. */
    data: ArrayBuffer;
  }
  function decode(options: { buffer: Buffer | Uint8Array }): Promise<DecodeResult>;
  export default decode;
}
