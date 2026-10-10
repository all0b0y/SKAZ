import { CANVAS, CROWN_CIRCLES, DEEP, GRID, GROUND, ROOT_CELLS, SAP, SAP_GRID } from './treeGeometry';

// The trunk polygon spans x 444–580 between the crown and the ground; the first
// sap pixel sits on the junction where the roots meet the trunk.
const insideTrunk = (x: number, y: number) => x >= 444 && x <= 580 && y >= 470 && y <= GROUND + SAP_GRID / 2;
const insideCrown = (x: number, y: number) =>
  CROWN_CIRCLES.some(([cx, cy, r]) => Math.hypot(x - cx, y - cy) <= r);

describe('SKAZ tree geometry', () => {
  it('keeps every root pixel below the ground and inside the canvas', () => {
    expect(ROOT_CELLS.length).toBeGreaterThan(60);
    for (const cell of ROOT_CELLS) {
      expect(cell.y + cell.size).toBeGreaterThan(GROUND);
      expect(cell.y).toBeGreaterThanOrEqual(GROUND - GRID);
      expect(cell.x).toBeGreaterThanOrEqual(0);
      expect(cell.x + cell.size).toBeLessThanOrEqual(CANVAS);
      expect(cell.y + cell.size).toBeLessThanOrEqual(DEEP + GRID);
    }
  });

  it('shrinks and fades the roots with depth, so they read as fragments', () => {
    const shallow = ROOT_CELLS.filter((c) => !c.fragment && c.depth < 0.2);
    const deep = ROOT_CELLS.filter((c) => c.depth > 0.8);
    expect(shallow.length).toBeGreaterThan(0);
    expect(deep.length).toBeGreaterThan(0);
    expect(Math.min(...shallow.map((c) => c.size))).toBeGreaterThan(Math.max(...deep.map((c) => c.size)));
    expect(Math.min(...shallow.map((c) => c.opacity))).toBeGreaterThan(Math.max(...deep.map((c) => c.opacity)));
    expect(ROOT_CELLS.some((c) => c.fragment)).toBe(true);
  });

  it('runs the sap only inside the tree silhouette, trunk first', () => {
    const cells = [...SAP.trunk, ...SAP.branches];
    for (const { x, y } of cells) expect(insideTrunk(x, y) || insideCrown(x, y)).toBe(true);
    const lastTrunkStep = Math.max(...SAP.trunk.map((c) => c.step));
    expect(Math.min(...SAP.branches.map((c) => c.step))).toBeGreaterThan(lastTrunkStep);
    expect(SAP.tips.length).toBeGreaterThanOrEqual(5);
    for (const tip of SAP.tips) expect(SAP.branches).toContain(tip);
  });
});
