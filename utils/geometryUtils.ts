
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

// Returns beam properties: length and angle (in degrees)
export const getBeamProperties = (entity: DxfEntity): { length: number, angle: number } => {
  if (entity.type === EntityType.LWPOLYLINE && entity.vertices && entity.vertices.length > 0) {
      if (entity.closed) {
         // Find the longest segment to determine length and orientation
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

/**
 * Checks intersection between a ray (start point + direction vector) and a bounding box.
 * Returns the distance to intersection if hit, or Infinity.
 */
const rayIntersectsBox = (start: Point, dir: Point, box: Bounds): number => {
    // Standard slab method for Ray-AABB intersection
    let tmin = -Infinity;
    let tmax = Infinity;

    // Check if dir is zero
    if (Math.abs(dir.x) < 1e-9 && Math.abs(dir.y) < 1e-9) return Infinity;

    // X axis
    if (Math.abs(dir.x) > 1e-9) {
        const tx1 = (box.minX - start.x) / dir.x;
        const tx2 = (box.maxX - start.x) / dir.x;
        tmin = Math.max(tmin, Math.min(tx1, tx2));
        tmax = Math.min(tmax, Math.max(tx1, tx2));
    } else if (start.x < box.minX || start.x > box.maxX) {
        return Infinity; // Parallel and outside
    }

    // Y axis
    if (Math.abs(dir.y) > 1e-9) {
        const ty1 = (box.minY - start.y) / dir.y;
        const ty2 = (box.maxY - start.y) / dir.y;
        tmin = Math.max(tmin, Math.min(ty1, ty2));
        tmax = Math.min(tmax, Math.max(ty1, ty2));
    } else if (start.y < box.minY || start.y > box.maxY) {
        return Infinity; // Parallel and outside
    }

    if (tmax < tmin) return Infinity; // No intersection
    if (tmax < 0) return Infinity; // Box is behind ray

    // If tmin < 0, start is inside box. We return tmin (negative) or 0? 
    // For "Beam Snap", if we are inside a column, we want to know that.
    // However, usually we cast from "clear air" towards wall. 
    // If tmin is positive, that's the distance to entry.
    return tmin;
};

const getRayIntersection = (start: Point, dir: Point, obstacles: DxfEntity[]): number => {
    let bestDist = Infinity;
    
    // Normalize direction
    const len = Math.sqrt(dir.x*dir.x + dir.y*dir.y);
    if (len === 0) return Infinity;
    const ndir = { x: dir.x/len, y: dir.y/len };

    for (const obs of obstacles) {
        const bounds = getEntityBounds(obs);
        if (!bounds) continue;
        
        // Expand bounds slightly (e.g. 1mm) to ensure robust hit
        const expanded = { 
            minX: bounds.minX - 1, minY: bounds.minY - 1,
            maxX: bounds.maxX + 1, maxY: bounds.maxY + 1
        };

        const dist = rayIntersectsBox(start, ndir, expanded);
        if (dist !== Infinity && dist < bestDist) {
            bestDist = dist;
        }
    }
    return bestDist;
};


// Reconstructs parallel lines into closed polygons (walls/beams)
export const findParallelPolygons = (
    lines: DxfEntity[], 
    tolerance = 600, 
    resultLayer = 'CALC_LAYER', 
    obstacles: DxfEntity[] = [],
    axisLines: DxfEntity[] = [] 
): DxfEntity[] => {
  const polygons: DxfEntity[] = [];
  const used = new Set<number>(); 

  // Sort lines by length descending to process main segments first
  const sortedLines = lines.map((l, i) => ({ l, i, len: calculateLength(l) })).sort((a, b) => b.len - a.len);

  for (let idxA = 0; idxA < sortedLines.length; idxA++) {
    const { l: l1, i: i, len: len1 } = sortedLines[idxA];
    if (used.has(i)) continue;
    if (l1.type !== EntityType.LINE || !l1.start || !l1.end) continue;
    if (len1 < 50) continue; // Ignore tiny lines

    const v1 = { x: l1.end.x - l1.start.x, y: l1.end.y - l1.start.y };
    
    let bestMatchIdx = -1;
    let minPerpDist = Infinity;

    for (let idxB = idxA + 1; idxB < sortedLines.length; idxB++) {
       const { l: l2, i: j, len: len2 } = sortedLines[idxB];
       if (used.has(j)) continue;
       if (l2.type !== EntityType.LINE || !l2.start || !l2.end) continue;

       if (Math.min(len1, len2) < 200) continue; 

       const v2 = { x: l2.end.x - l2.start.x, y: l2.end.y - l2.start.y };
       
       // Parallel Check
       const dot = (v1.x * v2.x + v1.y * v2.y) / (len1 * len2);
       if (Math.abs(dot) < 0.95) continue; 

       // Proximity Check
       const l2Center = { x: (l2.start.x + l2.end.x)/2, y: (l2.start.y + l2.end.y)/2 };
       const dist = distancePointToLine(l2Center, l1.start, l1.end);

       if (dist > tolerance || dist < 10) continue; 

       // Overlap Check
       const centerDist = distance(getCenter(l1)!, l2Center);
       const maxCombLen = (len1 + len2) / 2 + 1500;
       if (centerDist > maxCombLen) continue; 

       if (dist < minPerpDist) {
           minPerpDist = dist;
           bestMatchIdx = j;
       }
    }

    if (bestMatchIdx !== -1) {
        const l2 = lines.find((_, idx) => idx === bestMatchIdx);
        let isValid = true;

        // Validation: Check for required AXIS line
        if (axisLines.length > 0 && l2 && l2.start && l2.end) {
            const pairCenter = {
                x: (l1.start.x + l1.end.x + l2.start.x + l2.end.x) / 4,
                y: (l1.start.y + l1.end.y + l2.start.y + l2.end.y) / 4
            };
            
            const hasValidAxis = axisLines.some(axis => {
                if (axis.type !== EntityType.LINE || !axis.start || !axis.end) return false;
                
                // 1. Distance check (Axis should be roughly inside the beam, so close to center)
                const distToCenter = distancePointToLine(pairCenter, axis.start, axis.end);
                if (distToCenter > 1000) return false; // Tolerance ~1m

                // 2. Parallel check
                const adx = axis.end.x - axis.start.x;
                const ady = axis.end.y - axis.start.y;
                const alen = Math.sqrt(adx*adx + ady*ady);
                const l1len = Math.sqrt(v1.x*v1.x + v1.y*v1.y);
                const dot = (v1.x * adx + v1.y * ady) / (l1len * alen);
                
                return Math.abs(dot) > 0.95;
            });

            if (!hasValidAxis) {
                isValid = false;
            }
        }

        if (isValid && l2) {
            used.add(i);
            used.add(bestMatchIdx);
            
            const poly = createPolygonFromPair(l1, l2, resultLayer, obstacles);
            if (poly) polygons.push(poly);
        }
    }
  }
  return polygons;
};

const createPolygonFromPair = (l1: DxfEntity, l2: DxfEntity, layer: string, obstacles: DxfEntity[]): DxfEntity | null => {
    if (!l1.start || !l1.end || !l2.start || !l2.end) return null;

    // 1. Establish Coordinate System based on Line 1
    const v1 = { x: l1.end.x - l1.start.x, y: l1.end.y - l1.start.y };
    const len1 = Math.sqrt(v1.x*v1.x + v1.y*v1.y);
    if (len1 === 0) return null;
    const u = { x: v1.x/len1, y: v1.y/len1 }; // Unit vector along beam axis

    // Project points onto Line 1 axis
    const getT = (p: Point) => (p.x - l1.start!.x) * u.x + (p.y - l1.start!.y) * u.y;

    const tA1 = 0; // l1.start
    const tA2 = len1; // l1.end
    const tB1 = getT(l2.start);
    const tB2 = getT(l2.end);

    const tMinUnion = Math.min(tA1, tA2, tB1, tB2);
    const tMaxUnion = Math.max(tA1, tA2, tB1, tB2);
    
    // Intersection (Overlap) tells us where the beam "body" definitely is
    const tMinOverlap = Math.max(Math.min(tA1, tA2), Math.min(tB1, tB2));
    const tMaxOverlap = Math.min(Math.max(tA1, tA2), Math.max(tB1, tB2));

    // If no significant overlap, maybe not a beam pair?
    if (tMaxOverlap - tMinOverlap < -500) return null; 

    // 2. Calculate Perpendicular Vector to reach L2 (Beam Width)
    const projL2Start = { x: l1.start.x + u.x * tB1, y: l1.start.y + u.y * tB1 };
    const vPerp = { x: l2.start.x - projL2Start.x, y: l2.start.y - projL2Start.y };
    
    // 3. Find Beam Center Point (Start raycasting from middle of overlap)
    // We use the overlap midpoint to avoid starting inside a column at the ends
    const midT = (tMinOverlap + tMaxOverlap) / 2;
    // The "Geometric Center" of the beam (between L1 and L2)
    const beamCenter = { 
        x: l1.start.x + u.x * midT + vPerp.x * 0.5,
        y: l1.start.y + u.y * midT + vPerp.y * 0.5
    };

    // 4. Raycast Forward (+u) and Backward (-u) to snap to obstacles
    const SNAP_TOLERANCE = 2000; // Snap to column if within 2m of expected end

    // Forward
    const distFwd = getRayIntersection(beamCenter, u, obstacles);
    let finalEndT = tMaxUnion;
    
    if (distFwd !== Infinity) {
        const hitT = midT + distFwd;
        // Logic: 
        // 1. Trim: If beam lines go PAST the column (hitT < tMaxUnion), cut it short.
        // 2. Extend: If beam lines stop SHORT of the column (hitT > tMaxUnion), extend if close enough.
        
        // If hit is BEFORE the line ends (Trim), or WITHIN tolerance after (Extend)
        if (hitT < tMaxUnion || (hitT - tMaxUnion < SNAP_TOLERANCE)) {
            finalEndT = hitT;
        }
    }

    // Backward
    const distBack = getRayIntersection(beamCenter, { x: -u.x, y: -u.y }, obstacles);
    let finalStartT = tMinUnion;

    if (distBack !== Infinity) {
        const hitT = midT - distBack;
        // Logic: Trim if hitT > tMinUnion, Extend if hitT < tMinUnion (within tolerance)
        if (hitT > tMinUnion || (tMinUnion - hitT < SNAP_TOLERANCE)) {
            finalStartT = hitT;
        }
    }

    // Safety: ensure positive length
    if (finalEndT - finalStartT < 100) return null;

    // 5. Construct Rectangle Vertices
    // Points on Base Line (L1 infinite line)
    const pStartBase = { x: l1.start.x + u.x * finalStartT, y: l1.start.y + u.y * finalStartT };
    const pEndBase = { x: l1.start.x + u.x * finalEndT, y: l1.start.y + u.y * finalEndT };

    // Rectangle Corners
    const c1 = pStartBase;
    const c2 = pEndBase;
    const c3 = { x: c2.x + vPerp.x, y: c2.y + vPerp.y };
    const c4 = { x: c1.x + vPerp.x, y: c1.y + vPerp.y };

    return {
        type: EntityType.LWPOLYLINE,
        layer: layer,
        vertices: [c1, c2, c3, c4],
        closed: true
    };
};
