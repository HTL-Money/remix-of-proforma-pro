// Minimal typings for gifenc@1.0.3 (ships untyped). Only the surface
// vaultGif.ts uses is declared.
declare module "gifenc" {
  export interface GIFEncoderStream {
    /** Append one frame of palette indices. `repeat` (first frame only):
     *  -1 = play once, 0 = loop forever, N>0 = N extra iterations. */
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      opts?: {
        palette?: number[][];
        delay?: number;
        repeat?: number;
        transparent?: boolean;
        transparentIndex?: number;
        dispose?: number;
        first?: boolean;
      },
    ): void;
    finish(): void;
    bytes(): Uint8Array;
  }
  export function GIFEncoder(opts?: { auto?: boolean; initialCapacity?: number }): GIFEncoderStream;
  export function quantize(rgba: Uint8Array | Uint8ClampedArray, maxColors: number, opts?: object): number[][];
  export function applyPalette(rgba: Uint8Array | Uint8ClampedArray, palette: number[][], format?: string): Uint8Array;
}
