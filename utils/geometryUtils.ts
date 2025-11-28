import { DxfEntity, EntityType, Point, Bounds } from '../types';

export const distance = (p1: Point, p2: Point): number => {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
};

export const distancePointToLine = (p: Point, lStart: Point, lEnd: Point): number => {
  const A = p.x - lStart.x;
  const B = p.y - lStart.y;
  const C = lEnd.x - lStart.x;
  const D = lEnd.y - lStart.y;

  const dot = A * C + B * D;
  const lenSq = C * C + D * D;
  let param = -1;
  if (lenSq !== 0) param = dot / lenSq;

  let xx, yy;

  if (param < 0) {
    xx = lStart.x;
    yy = lStart.y;
  } else if (param > 1) {
    xx = lEnd.x;
    yy = lEnd.y;
  } else {
    xx = lStart.x + param * C;
    yy = lStart.y + param * D;
  }

  const dx = p.x - xx;
  const dy = p.y - yy;
  return Math.sqrt(dx * dx + dy * dy);
};

// Calculates distance from point p to the infinite line passing through lStart and lEnd
export const distancePointToInfiniteLine = (p: Point, lStart: Point, lEnd: Point): number => {
  const A = lStart.y - lEnd.y;
  const B = lEnd.x - lStart.x;
  const C = -A * lStart.x - B * lStart.y;
  
  const numerator = Math.abs(A * p.x + B * p.y + C);
  const denominator = Math.sqrt(A * A + B * B);
  
  if (denominator === 0) return distance(p, lStart);
  return numerator / denominator;
};

export const getEntityBounds = (entity: DxfEntity): Bounds | null => {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const update = (p: Point) => {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  };

  if (entity.type === EntityType.LINE && entity.start && entity.end) {
    update(entity.start);
    update(entity.end);
  } else if (entity.type === EntityType.LWPOLYLINE && entity.vertices) {
    entity.vertices.forEach(update);
  } else if ((entity.type === EntityType.CIRCLE || entity.type === EntityType.ARC) && entity.center && entity.radius) {
    update({ x: entity.center.x - entity.radius, y: entity.center.y - entity.radius });
    update({ x: entity.center.x + entity.radius, y: entity.center.y + entity.radius });
  } else if ((entity.type === EntityType.TEXT || entity.type === EntityType.INSERT) && entity.start) {
    // Basic point bounds for text/insert if full geometry not available
    update(entity.start);
    // Rough estimate for text bounds if not provided
    if (entity.type === EntityType.TEXT && entity.text && entity.radius) {
         // radius acts as height for TEXT
         const h = entity.radius;
         const w = entity.text.length * h * 0.6; 
         // Assume horizontal for bound estimation
         update({ x: entity.start.x + w, y: entity.start.y + h });
    }
  } else if (entity.type === EntityType.DIMENSION) {
      if (entity.measureStart) update(entity.measureStart);
      if (entity.measureEnd) update(entity.measureEnd);
      if (entity.end) update(entity.end);
  } else {
    return null;
  }

  if (minX === Infinity) return null;
  return { minX, minY, maxX, maxY };
};

export const getCenter = (entity: DxfEntity): Point | null => {
  if (entity.type === EntityType.LINE && entity.start && entity.end) {
    return {
      x: (entity.start.x + entity.end.x) / 2,
      y: (entity.start.y + entity.end.y) / 2
    };
  }
  
  const bounds = getEntityBounds(entity);
  if (bounds) {
    return {
      x: (bounds.minX + bounds.maxX) / 2,
      y: (bounds.minY + bounds.maxY) / 2
    };
  }

  return entity.center || entity.start || null;
};

export const getBeamProperties = (entity: DxfEntity): { length: number, angle: number } => {
  if (entity.type === EntityType.LWPOLYLINE && entity.vertices && entity.vertices.length > 0) {
      if (entity.closed) {
         let maxLen = 0;
         let angle = 0;
         const verts = entity.vertices;
         const count = verts.length;
         
         for(let i=0; i<count; i++) {
             const p1 = verts[i];
             const p2 = verts[(i+1) % count];
             const d = distance(p1, p2);
             if (d > maxLen) {
                 maxLen = d;
                 angle = Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180 / Math.PI;
             }
         }
         return { length: maxLen, angle };
      }
  }
  return { length: calculateLength(entity), angle: 0 };
};

export const calculateLength = (entity: DxfEntity): number => {
  switch (entity.type) {
    case EntityType.LINE:
      if (entity.start && entity.end) {
        return distance(entity.start, entity.end);
      }
      return 0;

    case EntityType.LWPOLYLINE:
      if (entity.vertices && entity.vertices.length > 1) {
        if (entity.closed) {
           const props = getBeamProperties(entity);
           return props.length;
        }

        let len = 0;
        for (let i = 0; i < entity.vertices.length - 1; i++) {
          len += distance(entity.vertices[i], entity.vertices[i + 1]);
        }
        return len;
      }
      return 0;

    case EntityType.CIRCLE:
      if (entity.radius) return 2 * Math.PI * entity.radius;
      return 0;

    case EntityType.ARC:
      if (entity.radius && entity.startAngle !== undefined && entity.endAngle !== undefined) {
        let diff = entity.endAngle - entity.startAngle;
        if (diff < 0) diff += 360;
        return (diff * Math.PI / 180) * entity.radius;
      }
      return 0;

    default:
      return 0;
  }
};

export const transformPoint = (p: Point, scale: Point, rotationDeg: number, translation: Point): Point => {
  const sx = p.x * (scale.x || 1);
  const sy = p.y * (scale.y || 1);

  const rad = rotationDeg * Math.PI / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  
  const rx = sx * cos - sy * sin;
  const ry = sx * sin + sy * cos;

  return {
    x: rx + translation.x,
    y: ry + translation.y
  };
};

const rayIntersectsBox = (start: Point, dir: Point, box: Bounds): number => {
    let tmin = -Infinity;
    let tmax = Infinity;

    if (Math.abs(dir.x) < 1e-9 && Math.abs(dir.y) < 1e-9) return Infinity;

    if (Math.abs(dir.x) > 1e-9) {
        const tx1 = (box.minX - start.x) / dir.x;
        const tx2 = (box.maxX - start.x) / dir.x;
        tmin = Math.max(tmin, Math.min(tx1, tx2));
        tmax = Math.min(tmax, Math.max(tx1, tx2));
    } else if (start.x < box.minX || start.x > box.maxX) {
        return Infinity;
    }

    if (Math.abs(dir.y) > 1e-9) {
        const ty1 = (box.minY - start.y) / dir.y;
        const ty2 = (box.maxY - start.y) / dir.y;
        tmin = Math.max(tmin, Math.min(ty1, ty2));
        tmax = Math.min(tmax, Math.max(ty1, ty2));
    } else if (start.y < box.minY || start.y > box.maxY) {
        return Infinity;
    }

    if (tmax < tmin) return Infinity;
    
    // Standard logic: if tmin < 0 (inside), return tmax (exit)
    // This allows walls starting inside other boxes to be registered
    if (tmin < 0) return tmax;

    return tmin; 
};

const getRayIntersection = (start: Point, dir: Point, obstacles: DxfEntity[]): number => {
    let bestDist = Infinity;
    
    const len = Math.sqrt(dir.x*dir.x + dir.y*dir.y);
    if (len === 0) return Infinity;
    const ndir = { x: dir.x/len, y: dir.y/len };

    for (const obs of obstacles) {
        const bounds = getEntityBounds(obs);
        if (!bounds) continue;
        
        const dist = rayIntersectsBox(start, ndir, bounds);
        if (dist !== Infinity && dist < bestDist) {
            bestDist = dist;
        }
    }
    return bestDist;
};

// --- INTERVAL HELPERS ---
const mergeIntervals = (intervals: [number, number][]) => {
    if (intervals.length === 0) return [];
    intervals.sort((a, b) => a[0] - b[0]);
    const merged = [intervals[0]];
    for (let i = 1; i < intervals.length; i++) {
        const prev = merged[merged.length - 1];
        const curr = intervals[i];
        if (curr[0] < prev[1]) { // Overlap
            prev[1] = Math.max(prev[1], curr[1]);
        } else {
            merged.push(curr);
        }
    }
    return merged;
};

const subtractIntervals = (start: number, end: number, blockers: [number, number][]) => {
    let result = [[start, end]];
    for (const b of blockers) {
        const nextResult = [];
        for (const r of result) {
            // Case 1: b is outside r (no overlap) -> keep r
            if (b[1] <= r[0] || b[0] >= r[1]) {
                nextResult.push(r);
            } 
            // Case 2: b covers r completely -> remove r
            else if (b[0] <= r[0] && b[1] >= r[1]) {
                continue;
            }
            // Case 3: b cuts r in middle -> split r
            else if (b[0] > r[0] && b[1] < r[1]) {
                nextResult.push([r[0], b[0]]);
                nextResult.push([b[1], r[1]]);
            }
            // Case 4: b cuts start of r
            else if (b[0] <= r[0] && b[1] < r[1]) {
                nextResult.push([b[1], r[1]]);
            }
            // Case 5: b cuts end of r
            else if (b[0] > r[0] && b[1] >= r[1]) {
                nextResult.push([r[0], b[0]]);
            }
        }
        result = nextResult;
    }
    return result;
};
// -----------------------

const hasAxisBetween = (l1: DxfEntity, l2: DxfEntity, axisLines: DxfEntity[], gap: number): boolean => {
    if (!l1.start || !l1.end || axisLines.length === 0) return false;

    const mid1 = { x: (l1.start.x + l1.end.x)/2, y: (l1.start.y + l1.end.y)/2 };
    
    const v1 = { x: l1.end.x - l1.start.x, y: l1.end.y - l1.start.y };
    const len1 = Math.sqrt(v1.x*v1.x + v1.y*v1.y);
    if (len1 === 0) return false;
    const u1 = { x: v1.x/len1, y: v1.y/len1 };

    const tolerance = 200; // Relaxed tolerance for offset/near checks

    for (const axis of axisLines) {
        if (!axis.start || !axis.end) continue;
        
        const vA = { x: axis.end.x - axis.start.x, y: axis.end.y - axis.start.y };
        const lenA = Math.sqrt(vA.x*vA.x + vA.y*vA.y);
        if (lenA === 0) continue;

        const dot = (v1.x * vA.x + v1.y * vA.y) / (len1 * lenA);
        if (Math.abs(dot) < 0.98) continue; // Must be parallel

        const lateralDist = distancePointToInfiniteLine(mid1, axis.start, axis.end);
        
        if (lateralDist > gap + tolerance) continue;

        const tAs = ((axis.start.x - l1.start.x) * u1.x + (axis.start.y - l1.start.y) * u1.y);
        const tAe = ((axis.end.x - l1.start.x) * u1.x + (axis.end.y - l1.start.y) * u1.y);
        
        const minA = Math.min(tAs, tAe);
        const maxA = Math.max(tAs, tAe);
        
        const overlapStart = Math.max(0, minA);
        const overlapEnd = Math.min(len1, maxA);
        
        if (overlapEnd - overlapStart > 50) {
            return true;
        }
    }
    return false;
};

const createPolygonFromPair = (
    l1: DxfEntity, 
    l2: DxfEntity, 
    layer: string, 
    obstacles: DxfEntity[],
    mode: 'BEAM' | 'WALL',
    gap: number
): DxfEntity[] => {
    if (!l1.start || !l1.end || !l2.start || !l2.end) return [];

    const v1 = { x: l1.end.x - l1.start.x, y: l1.end.y - l1.start.y };
    const len1 = Math.sqrt(v1.x*v1.x + v1.y*v1.y);
    if (len1 === 0) return [];
    const u = { x: v1.x/len1, y: v1.y/len1 };

    const getT = (p: Point) => (p.x - l1.start!.x) * u.x + (p.y - l1.start!.y) * u.y;

    const tA1 = 0;
    const tA2 = len1;
    const tB1 = getT(l2.start);
    const tB2 = getT(l2.end);

    const tMinOverlap = Math.max(Math.min(tA1, tA2), Math.min(tB1, tB2));
    const tMaxOverlap = Math.min(Math.max(tA1, tA2), Math.max(tB1, tB2));

    const tMinUnion = Math.min(Math.min(tA1, tA2), Math.min(tB1, tB2));
    const tMaxUnion = Math.max(Math.max(tA1, tA2), Math.max(tB1, tB2));

    if (tMaxOverlap - tMinOverlap < 50) return [];

    const projL2Start = { x: l1.start.x + u.x * tB1, y: l1.start.y + u.y * tB1 };
    const vPerp = { x: l2.start.x - projL2Start.x, y: l2.start.y - projL2Start.y };

    if (mode === 'BEAM') {
        const blockers: [number, number][] = [];
        
        for (const obs of obstacles) {
             const bounds = getEntityBounds(obs);
             if (!bounds) continue;
             
             const corners = [
                 {x: bounds.minX, y: bounds.minY},
                 {x: bounds.maxX, y: bounds.minY},
                 {x: bounds.maxX, y: bounds.maxY},
                 {x: bounds.minX, y: bounds.maxY}
             ];
             
             let minU = Infinity, maxU = -Infinity;
             let minV = Infinity, maxV = -Infinity;
             
             for (const c of corners) {
                 const relX = c.x - l1.start!.x;
                 const relY = c.y - l1.start!.y;
                 const tU = relX * u.x + relY * u.y;
                 const nV = { x: vPerp.x/gap, y: vPerp.y/gap };
                 const tV = relX * nV.x + relY * nV.y;
                 
                 minU = Math.min(minU, tU);
                 maxU = Math.max(maxU, tU);
                 minV = Math.min(minV, tV);
                 maxV = Math.max(maxV, tV);
             }
             
             const beamVMin = 0;
             const beamVMax = gap;
             
             const latOverlapStart = Math.max(minV, beamVMin);
             const latOverlapEnd = Math.min(maxV, beamVMax);
             
             if (latOverlapEnd - latOverlapStart > 10) {
                 blockers.push([minU, maxU]);
             }
        }
        
        const mergedBlockers = mergeIntervals(blockers);
        const validIntervals = subtractIntervals(tMinUnion, tMaxUnion, mergedBlockers);
        
        const results: DxfEntity[] = [];
        
        for (const interval of validIntervals) {
            const startT = interval[0];
            const endT = interval[1];
            
            if (endT - startT < 200) continue; 
            
            const pStartBase = { x: l1.start.x + u.x * startT, y: l1.start.y + u.y * startT };
            const pEndBase = { x: l1.start.x + u.x * endT, y: l1.start.y + u.y * endT };
            
            const c1 = pStartBase;
            const c2 = pEndBase;
            const c3 = { x: c2.x + vPerp.x, y: c2.y + vPerp.y };
            const c4 = { x: c1.x + vPerp.x, y: c1.y + vPerp.y };
            
            results.push({
                type: EntityType.LWPOLYLINE,
                layer: layer,
                vertices: [c1, c2, c3, c4],
                closed: true
            });
        }
        
        return results;

    } else {
        let finalStartT = tMinOverlap;
        let finalEndT = tMaxOverlap;

        const cornerTolerance = gap * 2.5;
        const startDiff = tMinOverlap - tMinUnion;
        const endDiff = tMaxUnion - tMaxOverlap;

        if (startDiff > 0 && startDiff < cornerTolerance) finalStartT = tMinUnion;
        else finalStartT = tMinOverlap;

        if (endDiff > 0 && endDiff < cornerTolerance) finalEndT = tMaxUnion;
        else finalEndT = tMaxOverlap;

        const SNAP_TOLERANCE = gap * 1.5;

        // Trim/Extend Logic
        const endCenter = { 
            x: l1.start.x + u.x * finalEndT + vPerp.x * 0.5,
            y: l1.start.y + u.y * finalEndT + vPerp.y * 0.5
        };
        const distFwd = getRayIntersection(endCenter, u, obstacles);
        if (distFwd !== Infinity && distFwd < SNAP_TOLERANCE) {
             finalEndT = finalEndT + distFwd;
        }

        const startCenter = { 
            x: l1.start.x + u.x * finalStartT + vPerp.x * 0.5,
            y: l1.start.y + u.y * finalStartT + vPerp.y * 0.5
        };
        const distBack = getRayIntersection(startCenter, { x: -u.x, y: -u.y }, obstacles);
        if (distBack !== Infinity && distBack < SNAP_TOLERANCE) {
             finalStartT = finalStartT - distBack;
        }

        if (finalEndT - finalStartT < 50) return [];

        const p1 = { x: l1.start.x + u.x * finalStartT, y: l1.start.y + u.y * finalStartT };
        const p2 = { x: l1.start.x + u.x * finalEndT, y: l1.start.y + u.y * finalEndT };

        const projX = l1.start.x + u.x * tB1;
        const projY = l1.start.y + u.y * tB1;
        const offX = l2.start.x - projX;
        const offY = l2.start.y - projY;
        const offLen = Math.sqrt(offX*offX + offY*offY);
        
        const scale = (offLen > 0) ? (gap / offLen) : 1;
        const wX = offX * scale;
        const wY = offY * scale;

        const c1 = p1;
        const c2 = p2;
        const c3 = { x: p2.x + wX, y: p2.y + wY };
        const c4 = { x: p1.x + wX, y: p1.y + wY };

        return [{
            type: EntityType.LWPOLYLINE,
            layer: layer,
            vertices: [c1, c2, c3, c4],
            closed: true
        }];
    }
};

export const findParallelPolygons = (
    lines: DxfEntity[], 
    tolerance = 1200, 
    resultLayer = 'CALC_LAYER', 
    obstacles: DxfEntity[] = [],
    axisLines: DxfEntity[] = [],
    textEntities: DxfEntity[] = [],
    mode: 'BEAM' | 'WALL' = 'BEAM',
    validWidths: Set<number> = new Set()
): DxfEntity[] => {
  const polygons: DxfEntity[] = [];
  const used = new Set<number>(); 

  const sortedLines = lines.map((l, i) => ({ l, i, len: calculateLength(l) })).sort((a, b) => b.len - a.len);

  for (let idxA = 0; idxA < sortedLines.length; idxA++) {
    const { l: l1, i: i, len: len1 } = sortedLines[idxA];
    if (used.has(i)) continue;
    if (l1.type !== EntityType.LINE || !l1.start || !l1.end) continue;
    if (len1 < 50) continue;

    const v1 = { x: l1.end.x - l1.start.x, y: l1.end.y - l1.start.y };
    
    for (let idxB = idxA + 1; idxB < sortedLines.length; idxB++) {
       const { l: l2, i: j, len: len2 } = sortedLines[idxB];
       if (used.has(j)) continue;
       if (l2.type !== EntityType.LINE || !l2.start || !l2.end) continue;

       if (Math.min(len1, len2) < 200) continue; 

       const v2 = { x: l2.end.x - l2.start.x, y: l2.end.y - l2.start.y };
       const dot = (v1.x * v2.x + v1.y * v2.y) / (len1 * len2);
       if (Math.abs(dot) < 0.95) continue; 

       const l2Center = { x: (l2.start.x + l2.end.x)/2, y: (l2.start.y + l2.end.y)/2 };
       const dist = distancePointToLine(l2Center, l1.start, l1.end);

       if (dist > tolerance || dist < 10) continue; 

       const u = { x: v1.x/len1, y: v1.y/len1 };
       const getT = (p: Point) => (p.x - l1.start!.x) * u.x + (p.y - l1.start!.y) * u.y;
       
       const tB1 = getT(l2.start);
       const tB2 = getT(l2.end);
       const tMinB = Math.min(tB1, tB2);
       const tMaxB = Math.max(tB1, tB2);
       
       const overlapMin = Math.max(0, tMinB);
       const overlapMax = Math.min(len1, tMaxB);
       const overlapLen = overlapMax - overlapMin;

       if (overlapLen < 50) continue; 

       let isValid = false; 
       const gap = dist;

       if (mode === 'WALL') {
             const axisFound = hasAxisBetween(l1, l2, axisLines, gap);
             if (axisFound) {
                 isValid = true;
             }
       } else {
             if (validWidths.size > 0) {
                 for (const w of validWidths) {
                     if (Math.abs(gap - w) <= 2.5) {
                         isValid = true;
                         break;
                     }
                 }
             } else {
                 if (gap >= 100 && gap <= 1000) isValid = true; 
             }
       }

       if (isValid) {
            const resultEntities = createPolygonFromPair(l1, l2, resultLayer, obstacles, mode, gap);
            if (resultEntities.length > 0) {
                polygons.push(...resultEntities);
                used.add(j); 
            }
       }
    }
    used.add(i);
  }
  return polygons;
};

export const calculateTotalBounds = (
    entities: DxfEntity[], 
    blocks: Record<string, DxfEntity[]>, 
    activeLayers: Set<string> | null = null
): Bounds => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let hasEntities = false;

    const checkPoint = (x: number, y: number) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      hasEntities = true;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    };

    const processEntity = (ent: DxfEntity, offsetX = 0, offsetY = 0, scaleX = 1, scaleY = 1, rotation = 0) => {
       const isLayerActive = !activeLayers || activeLayers.has(ent.layer);
       if (!isLayerActive && ent.type !== EntityType.INSERT) return;

       const transformAndCheck = (localX: number, localY: number) => {
          let tx = localX * scaleX;
          let ty = localY * scaleY;
          if (rotation !== 0) {
              const rad = rotation * Math.PI / 180;
              const rx = tx * Math.cos(rad) - ty * Math.sin(rad);
              const ry = tx * Math.sin(rad) + ty * Math.cos(rad);
              tx = rx;
              ty = ry;
          }
          checkPoint(tx + offsetX, ty + offsetY);
       };

       if (isLayerActive) {
           if (ent.type === EntityType.LINE && ent.start && ent.end) {
             transformAndCheck(ent.start.x, ent.start.y);
             transformAndCheck(ent.end.x, ent.end.y);
           } else if (ent.type === EntityType.LWPOLYLINE && ent.vertices) {
             ent.vertices.forEach(v => transformAndCheck(v.x, v.y));
           } else if ((ent.type === EntityType.CIRCLE || ent.type === EntityType.ARC) && ent.center && ent.radius) {
             transformAndCheck(ent.center.x - ent.radius, ent.center.y - ent.radius);
             transformAndCheck(ent.center.x + ent.radius, ent.center.y + ent.radius);
           } else if ((ent.type === EntityType.TEXT || ent.type === EntityType.ATTRIB) && ent.start) {
             transformAndCheck(ent.start.x, ent.start.y);
           } else if (ent.type === EntityType.DIMENSION) {
              if (ent.measureStart) transformAndCheck(ent.measureStart.x, ent.measureStart.y);
              if (ent.measureEnd) transformAndCheck(ent.measureEnd.x, ent.measureEnd.y);
              if (ent.end) transformAndCheck(ent.end.x, ent.end.y); 
           }
       }
       
       if (ent.type === EntityType.INSERT && ent.start && ent.blockName && blocks[ent.blockName]) {
          const subEntities = blocks[ent.blockName];
          let insLocalX = ent.start.x * scaleX;
          let insLocalY = ent.start.y * scaleY;
          if (rotation !== 0) {
             const r = rotation * Math.PI / 180;
             const tx = insLocalX * Math.cos(r) - insLocalY * Math.sin(r);
             const ty = insLocalX * Math.sin(r) + insLocalY * Math.cos(r);
             insLocalX = tx;
             insLocalY = ty;
          }
          const nextOffsetX = offsetX + insLocalX;
          const nextOffsetY = offsetY + insLocalY;
          const nextScaleX = scaleX * (ent.scale?.x || 1);
          const nextScaleY = scaleY * (ent.scale?.y || 1);
          const nextRotation = rotation + (ent.rotation || 0);

          const rows = ent.rowCount || 1;
          const cols = ent.columnCount || 1;
          const rSpace = ent.rowSpacing || 0;
          const cSpace = ent.columnSpacing || 0;

          if (rows === 1 && cols === 1) {
              subEntities.forEach(sub => {
                  processEntity(sub, nextOffsetX, nextOffsetY, nextScaleX, nextScaleY, nextRotation);
              });
          } else {
              for (let r = 0; r < rows; r++) {
                  for (let c = 0; c < cols; c++) {
                      let gridX = c * cSpace;
                      let gridY = r * rSpace;
                      let rGridX = gridX * scaleX; 
                      let rGridY = gridY * scaleY;

                      if (ent.rotation) {
                          const rad = ent.rotation * Math.PI / 180;
                          const tx = rGridX * Math.cos(rad) - rGridY * Math.sin(rad);
                          const ty = rGridX * Math.sin(rad) + rGridY * Math.cos(rad);
                          rGridX = tx;
                          rGridY = ty;
                      }
                      const finalOffsetX = nextOffsetX + rGridX;
                      const finalOffsetY = nextOffsetY + rGridY;

                      subEntities.forEach(sub => {
                          processEntity(sub, finalOffsetX, finalOffsetY, nextScaleX, nextScaleY, nextRotation);
                      });
                  }
              }
          }
       }
    };

    entities.forEach(ent => processEntity(ent));
    if (!hasEntities) return { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    return { minX, minY, maxX, maxY };
};

// --- VIEWPORT SEGMENTATION HELPERS ---

export const groupEntitiesByProximity = (entities: DxfEntity[], tolerance = 5000): Bounds[] => {
    // 1. Convert each entity to a Bounding Box
    const boxes: Bounds[] = [];
    entities.forEach(e => {
        const b = getEntityBounds(e);
        if (b) boxes.push(b);
    });

    if (boxes.length === 0) return [];

    // 2. Cluster boxes using Union-Find or simple iterative merging
    // Since we expect a few major clusters (Buildings), iterative merge is fine.
    let clusters = boxes;
    let changed = true;

    while (changed) {
        changed = false;
        const newClusters: Bounds[] = [];
        const merged = new Set<number>();

        for (let i = 0; i < clusters.length; i++) {
            if (merged.has(i)) continue;
            let current = clusters[i];
            
            for (let j = i + 1; j < clusters.length; j++) {
                if (merged.has(j)) continue;
                const other = clusters[j];

                // Check intersection with tolerance (Expansion)
                const intersects = !(
                    other.minX > current.maxX + tolerance ||
                    other.maxX < current.minX - tolerance ||
                    other.minY > current.maxY + tolerance ||
                    other.maxY < current.minY - tolerance
                );

                if (intersects) {
                    // Merge
                    current = {
                        minX: Math.min(current.minX, other.minX),
                        minY: Math.min(current.minY, other.minY),
                        maxX: Math.max(current.maxX, other.maxX),
                        maxY: Math.max(current.maxY, other.maxY)
                    };
                    merged.add(j);
                    changed = true;
                }
            }
            newClusters.push(current);
        }
        clusters = newClusters;
    }
    return clusters;
};

export const findTitleForBounds = (
    box: Bounds, 
    texts: DxfEntity[], 
    lines: DxfEntity[], 
    layerFilter: string = '',
    maxMargin = 25000 
): { title: string | null, scannedBounds: Bounds[] } => {
    // Search in expanding rings to find the *nearest* title
    const step = 500; // Step size in CAD units (mm)
    const scannedBounds: Bounds[] = [];
    
    // Start from the first expanded ring (skip margin 0 to avoid searching inside the original box)
    for (let currentMargin = step; currentMargin <= maxMargin; currentMargin += step) {

        const innerMargin = Math.max(0, currentMargin - step);
        
        const outerBox = {
            minX: box.minX - currentMargin,
            minY: box.minY - currentMargin,
            maxX: box.maxX + currentMargin,
            maxY: box.maxY + currentMargin
        };
        
        const innerBox = {
             minX: box.minX - innerMargin,
             minY: box.minY - innerMargin,
             maxX: box.maxX + innerMargin,
             maxY: box.maxY + innerMargin
        };

        scannedBounds.push(outerBox);

        const candidates = texts.filter(t => {
            if (!t.start || !t.text) return false;
            
            // Check if inside outer ring
            if (t.start.x < outerBox.minX || t.start.x > outerBox.maxX ||
                t.start.y < outerBox.minY || t.start.y > outerBox.maxY) return false;

            // Check if outside inner ring (optimization to check only new area)
            if (currentMargin > 0) {
                 if (t.start.x >= innerBox.minX && t.start.x <= innerBox.maxX &&
                     t.start.y >= innerBox.minY && t.start.y <= innerBox.maxY) return false;
            }

            // Exclude unwanted layers (Standard practice: Grid IDs and Dimensions are not titles)
            if (t.layer.toUpperCase().includes('AXIS') || t.layer.toUpperCase().includes('DIM')) return false;

            // Filter by specific layer if user provided one
            if (layerFilter && !t.layer.toUpperCase().includes(layerFilter.toUpperCase())) return false;

            // Exclude Numeric / Dimensions (e.g. "200", "200x500", "3.60")
            // Regex matches strings that are purely numbers, whitespace, or math/dimension symbols
            if (/^[\d\s,.xX*×+-=]+$/.test(t.text)) return false;

            return true;
        });

        const validTitles: DxfEntity[] = [];

        for (const txt of candidates) {
            const h = txt.radius || 300; 
            const w = (txt.text!.length) * h * 0.7;
            const txtBounds = {
                minX: txt.start!.x,
                maxX: txt.start!.x + w,
                minY: txt.start!.y,
                maxY: txt.start!.y + h
            };

            // Check for Underline (Line or Polyline Segment)
            const hasUnderline = lines.some(l => {
                const checkSegment = (p1: Point, p2: Point) => {
                    if (Math.abs(p1.y - p2.y) > h * 0.5) return false; // Not horizontal
                    
                    const lineY = (p1.y + p2.y) / 2;
                    const verticalGap = txtBounds.minY - lineY; // Distance from Text Bottom to Line
                    
                    // Relaxed Check: Allow line to slightly touch text (-0.2h) or be up to 0.6h below
                    if (verticalGap < -h * 0.2 || verticalGap > h * 0.6) return false;

                    const lineMinX = Math.min(p1.x, p2.x);
                    const lineMaxX = Math.max(p1.x, p2.x);
                    
                    const overlap = Math.min(lineMaxX, txtBounds.maxX) - Math.max(lineMinX, txtBounds.minX);
                    return overlap > w * 0.3;
                };

                if (l.type === EntityType.LINE && l.start && l.end) {
                    return checkSegment(l.start, l.end);
                } else if (l.type === EntityType.LWPOLYLINE && l.vertices && l.vertices.length > 1) {
                    for (let i = 0; i < l.vertices.length - 1; i++) {
                        if (checkSegment(l.vertices[i], l.vertices[i+1])) return true;
                    }
                }
                return false;
            });

            if (hasUnderline) {
                validTitles.push(txt);
            }
        }

        if (validTitles.length > 0) {
            // Found titles in this ring. 
            // Sort by Height (largest first)
            validTitles.sort((a, b) => (b.radius || 0) - (a.radius || 0));
            return { title: validTitles[0].text!, scannedBounds };
        }
    }

    return { title: null, scannedBounds };
};