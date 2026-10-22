/*
 * The chat backdrop as one stateful painter: the energy and the two clocks, the per-size grid, one
 * reused ImageData on an off-screen canvas of one pixel per cell, scaled up without smoothing.
 */
import type { FxColors } from '../colors';
import {
  backdropFrameMs, backdropGrid, BACKDROP_CELL, driftRate, easeEnergy, flowRate, renderBackdrop, SETTLE_S,
  type BackdropGrid, type BackdropState,
} from './backdrop';

export class BackdropScene implements BackdropState {
  energy = 0;
  /** 1 while the agent works, else 0. */
  target = 0;
  driftT = 0;
  flowT = 0;
  /** Seconds at rest with nothing changing. */
  private idle = 0;
  private grid: BackdropGrid | null = null;
  private off: HTMLCanvasElement | null = null;
  private offCtx: CanvasRenderingContext2D | null = null;
  private image: ImageData | null = null;

  constructor(private readonly cell: number = BACKDROP_CELL) {}

  /** The agent started or stopped working: energy eases towards 1 or 0 from here. */
  setWorking(on: boolean): void {
    this.target = on ? 1 : 0;
    if (on) this.idle = 0;
  }

  /** Advance by `dt` seconds: the clocks move at the current energy's rate, then the energy eases. */
  step(dt: number): void {
    if (dt <= 0) return;
    const e = this.energy;
    this.driftT += dt * driftRate(e);
    this.flowT += dt * flowRate(e);
    this.energy = easeEnergy(e, this.target, dt);
    // Still only counts from a step that began at rest: the one that lands on 0 still moved.
    this.idle = this.target === 0 && e === 0 ? this.idle + dt : 0;
  }

  /** At rest for SETTLE_S: the loop can stop and leave the still frame. */
  get settled(): boolean { return this.target === 0 && this.energy === 0 && this.idle >= SETTLE_S; }

  /** The least ms between frames now (useFxLoop asks every tick). */
  get frameMs(): number { return backdropFrameMs(this.target, this.energy); }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, colors: FxColors): void {
    const g = this.ensureGrid(w, h);
    if (!g || !this.offCtx || !this.off || !this.image) return;
    renderBackdrop(this.image.data, g, this, colors.ink, colors.accent);
    this.offCtx.putImageData(this.image, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.off, 0, 0, g.cols * this.cell, g.rows * this.cell);
  }

  private ensureGrid(w: number, h: number): BackdropGrid | null {
    if (this.grid && this.grid.w === w && this.grid.h === h) return this.grid;
    if (!this.off) {
      this.off = document.createElement('canvas');
      this.offCtx = this.off.getContext('2d');
    }
    if (!this.offCtx) return null;
    const g = backdropGrid(w, h, this.cell);
    if (g.cols === 0 || g.rows === 0) return null;
    this.off.width = g.cols;
    this.off.height = g.rows;
    this.image = this.offCtx.createImageData(g.cols, g.rows);
    this.grid = g;
    return g;
  }
}
