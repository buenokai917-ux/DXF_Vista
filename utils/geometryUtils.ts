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
    update(entity.start);
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
    if (tmax < 0) return Infinity; // Box is fully behind

    // If start is inside the box (tmin < 0), return exit point (tmax)
    // This allows walls starting inside another wall (e.g. at axis) to snap to the far side
    if (tmin < 0) return tmax;

    return tmin; // Returns entry point
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

const parseBeamWidth = (text: string): number | null => {
    const match = text.match(/(\d{3,})[xX×]\d+/);
    if (match) {
        return parseInt(match[1], 10);
    }
    return null;
};

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

        // 1. Lateral Check: Is the Axis line laterally "inside" or very close to the wall?
        // We use infinite line distance to ignore the length of axis for this step.
        const lateralDist = distancePointToInfiniteLine(mid1, axis.start, axis.end);
        
        // The axis should be roughly within the gap distance from the wall line (0 to gap).
        if (lateralDist > gap + tolerance) continue;

        // 2. Longitudinal Overlap Check: Does the axis actually span along the wall segment?
        // Project Axis endpoints onto Wall Line 1
        const tAs = ((axis.start.x - l1.start.x) * u1.x + (axis.start.y - l1.start.y) * u1.y);
        const tAe = ((axis.end.x - l1.start.x) * u1.x + (axis.end.y - l1.start.y) * u1.y);
        
        const minA = Math.min(tAs, tAe);
        const maxA = Math.max(tAs, tAe);
        
        // Wall interval is [0, len1]
        const overlapStart = Math.max(0, minA);
        const overlapEnd = Math.min(len1, maxA);
        
        // If there is significant longitudinal overlap (> 50 units), it's a match
        if (overlapEnd - overlapStart > 50) {
            return true;
        }
    }
    return false;
};

export const findParallelPolygons = (
    lines: DxfEntity[], 
    tolerance = 1200, 
    resultLayer = 'CALC_LAYER', 
    obstacles: DxfEntity[] = [],
    axisLines: DxfEntity[] = [],
    textEntities: DxfEntity[] = [],
    mode: 'BEAM' | 'WALL' = 'BEAM'
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
    
    // ONE-TO-MANY MATCHING SUPPORT:
    // We scan ALL other lines. If l1 is parallel to multiple segments (e.g. wall with openings),
    // we create polygons for ALL of them. This is crucial for fixing missing wall sections.
    for (let idxB = idxA + 1; idxB < sortedLines.length; idxB++) {
       const { l: l2, i: j, len: len2 } = sortedLines[idxB];
       if (used.has(j)) continue;
       if (l2.type !== EntityType.LINE || !l2.start || !l2.end) continue;

       // If lengths are too mismatched and small, skip, but allow long matching short
       if (Math.min(len1, len2) < 200) continue; 

       const v2 = { x: l2.end.x - l2.start.x, y: l2.end.y - l2.start.y };
       const dot = (v1.x * v2.x + v1.y * v2.y) / (len1 * len2);
       if (Math.abs(dot) < 0.95) continue; 

       const l2Center = { x: (l2.start.x + l2.end.x)/2, y: (l2.start.y + l2.end.y)/2 };
       const dist = distancePointToLine(l2Center, l1.start, l1.end);

       if (dist > tolerance || dist < 10) continue; 

       // Calculate Intersection/Overlap
       const u = { x: v1.x/len1, y: v1.y/len1 };
       const getT = (p: Point) => (p.x - l1.start!.x) * u.x + (p.y - l1.start!.y) * u.y;
       
       const tB1 = getT(l2.start);
       const tB2 = getT(l2.end);
       const tMinB = Math.min(tB1, tB2);
       const tMaxB = Math.max(tB1, tB2);
       
       // Check overlap with l1 segment (0 to len1)
       const overlapMin = Math.max(0, tMinB);
       const overlapMax = Math.min(len1, tMaxB);
       const overlapLen = overlapMax - overlapMin;

       if (overlapLen < 50) continue; 

       let isValid = false; 
       const gap = dist;

       if (mode === 'WALL') {
             // For Walls, verify Axis exists strictly between the pair
             const axisFound = hasAxisBetween(l1, l2, axisLines, gap);
             if (axisFound) {
                 isValid = true;
             }
       } else {
             // BEAM MODE
             let foundAxis: DxfEntity | null = null;
             if (axisLines.length > 0) {
                const pairCenter = {
                    x: (l1.start.x + l1.end.x + l2.start.x + l2.end.x) / 4,
                    y: (l1.start.y + l1.end.y + l2.start.y + l2.end.y) / 4
                };
                foundAxis = axisLines.find(axis => {
                    if (axis.type !== EntityType.LINE || !axis.start || !axis.end) return false;
                    const distToCenter = distancePointToLine(pairCenter, axis.start, axis.end);
                    if (distToCenter > gap * 0.8) return false; 
                    const adx = axis.end.x - axis.start.x;
                    const ady = axis.end.y - axis.start.y;
                    const alen = Math.sqrt(adx*adx + ady*ady);
                    const l1len = Math.sqrt(v1.x*v1.x + v1.y*v1.y);
                    const dot = (v1.x * adx + v1.y * ady) / (l1len * alen);
                    return Math.abs(dot) > 0.95;
                }) || null;
             }

             if (foundAxis) {
                 let widthFromText: number | null = null;
                 for (const txt of textEntities) {
                     if (!txt.start || !txt.text) continue;
                     const distTextToAxis = distancePointToInfiniteLine(txt.start, foundAxis.start!, foundAxis.end!);
                     if (distTextToAxis < 500) {
                         const w = parseBeamWidth(txt.text);
                         if (w) { widthFromText = w; break; }
                     }
                 }
                 if (widthFromText) {
                     if (Math.abs(gap - widthFromText) < 50) isValid = true;
                 } else {
                     isValid = true;
                 }
             } else {
                 if (gap <= 300) isValid = true;
             }
       }

       if (isValid) {
            const poly = createPolygonFromPair(l1, l2, resultLayer, obstacles, mode, gap);
            if (poly) {
                polygons.push(poly);
                used.add(j); // Mark secondary line as used
            }
       }
    }
    
    // Mark primary line as used after checking all possible secondary matches
    used.add(i);
  }
  return polygons;
};

const createPolygonFromPair = (
    l1: DxfEntity, 
    l2: DxfEntity, 
    layer: string, 
    obstacles: DxfEntity[],
    mode: 'BEAM' | 'WALL',
    gap: number
): DxfEntity | null => {
    if (!l1.start || !l1.end || !l2.start || !l2.end) return null;

    const v1 = { x: l1.end.x - l1.start.x, y: l1.end.y - l1.start.y };
    const len1 = Math.sqrt(v1.x*v1.x + v1.y*v1.y);
    if (len1 === 0) return null;
    const u = { x: v1.x/len1, y: v1.y/len1 };

    const getT = (p: Point) => (p.x - l1.start!.x) * u.x + (p.y - l1.start!.y) * u.y;

    const tA1 = 0;
    const tA2 = len1;
    const tB1 = getT(l2.start);
    const tB2 = getT(l2.end);

    // Overlap range
    const tMinOverlap = Math.max(Math.min(tA1, tA2), Math.min(tB1, tB2));
    const tMaxOverlap = Math.min(Math.max(tA1, tA2), Math.max(tB1, tB2));

    // Union range
    const tMinUnion = Math.min(Math.min(tA1, tA2), Math.min(tB1, tB2));
    const tMaxUnion = Math.max(Math.max(tA1, tA2), Math.max(tB1, tB2));

    if (tMaxOverlap - tMinOverlap < 50) return null;

    let finalStartT = tMinOverlap;
    let finalEndT = tMaxOverlap;

    if (mode === 'BEAM') {
        const projL2Start = { x: l1.start.x + u.x * tB1, y: l1.start.y + u.y * tB1 };
        const vPerp = { x: l2.start.x - projL2Start.x, y: l2.start.y - projL2Start.y };
        
        const midT = (tMinOverlap + tMaxOverlap) / 2;
        const beamCenter = { 
            x: l1.start.x + u.x * midT + vPerp.x * 0.5,
            y: l1.start.y + u.y * midT + vPerp.y * 0.5
        };
        const SNAP_TOLERANCE = 2000; 

        const distFwd = getRayIntersection(beamCenter, u, obstacles);
        finalEndT = tMaxUnion; 
        if (distFwd !== Infinity) {
            const hitT = midT + distFwd;
            if (hitT < tMaxUnion || (hitT - tMaxUnion < SNAP_TOLERANCE)) finalEndT = hitT;
        }

        const distBack = getRayIntersection(beamCenter, { x: -u.x, y: -u.y }, obstacles);
        finalStartT = tMinUnion;
        if (distBack !== Infinity) {
            const hitT = midT - distBack;
            if (hitT > tMinUnion || (tMinUnion - hitT < SNAP_TOLERANCE)) finalStartT = hitT;
        }

        const pStartBase = { x: l1.start.x + u.x * finalStartT, y: l1.start.y + u.y * finalStartT };
        const pEndBase = { x: l1.start.x + u.x * finalEndT, y: l1.start.y + u.y * finalEndT };

        const c1 = pStartBase;
        const c2 = pEndBase;
        const c3 = { x: c2.x + vPerp.x, y: c2.y + vPerp.y };
        const c4 = { x: c1.x + vPerp.x, y: c1.y + vPerp.y };

        return { type: EntityType.LWPOLYLINE, layer: layer, vertices: [c1, c2, c3, c4], closed: true };

    } else {
        // WALL Mode
        const cornerTolerance = gap * 2.5;
        const startDiff = tMinOverlap - tMinUnion;
        const endDiff = tMaxUnion - tMaxOverlap;

        if (startDiff > 0 && startDiff < cornerTolerance) finalStartT = tMinUnion;
        else finalStartT = tMinOverlap;

        if (endDiff > 0 && endDiff < cornerTolerance) finalEndT = tMaxUnion;
        else finalEndT = tMaxOverlap;

        // --- Snapping / Raycasting for Walls (T-Junctions) ---
        const SNAP_TOLERANCE = gap * 1.5;

        // Prepare ray origin/direction perpendicular to wall
        const projL2Start = { x: l1.start.x + u.x * tB1, y: l1.start.y + u.y * tB1 };
        const vPerp = { x: l2.start.x - projL2Start.x, y: l2.start.y - projL2Start.y };
        
        // Shoot ray from the END
        const endCenter = { 
            x: l1.start.x + u.x * finalEndT + vPerp.x * 0.5,
            y: l1.start.y + u.y * finalEndT + vPerp.y * 0.5
        };
        const distFwd = getRayIntersection(endCenter, u, obstacles);
        if (distFwd !== Infinity && distFwd < SNAP_TOLERANCE) {
             finalEndT = finalEndT + distFwd;
        }

        // Shoot ray from the START
        const startCenter = { 
            x: l1.start.x + u.x * finalStartT + vPerp.x * 0.5,
            y: l1.start.y + u.y * finalStartT + vPerp.y * 0.5
        };
        const distBack = getRayIntersection(startCenter, { x: -u.x, y: -u.y }, obstacles);
        if (distBack !== Infinity && distBack < SNAP_TOLERANCE) {
             finalStartT = finalStartT - distBack;
        }

        if (finalEndT - finalStartT < 50) return null;

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

        return {
            type: EntityType.LWPOLYLINE,
            layer: layer,
            vertices: [c1, c2, c3, c4],
            closed: true
        };
    }
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