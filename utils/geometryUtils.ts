import { DxfEntity, EntityType, Point, Bounds } from '../types';

export const distance = (p1: Point, p2: Point): number => {
  return Math.sqrt(Math.pow(p2.x - p1.x, 2) + Math.pow(p2.y - p1.y, 2));
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

export const calculateLength = (entity: DxfEntity): number => {
  switch (entity.type) {
    case EntityType.LINE:
      if (entity.start && entity.end) {
        return distance(entity.start, entity.end);
      }
      return 0;

    case EntityType.LWPOLYLINE:
      if (entity.vertices && entity.vertices.length > 1) {
        // If it's a closed polyline (like a beam outline), the "length" of the beam
        // is essentially the longest dimension of its bounding box, not the perimeter.
        if (entity.closed) {
           const bounds = getEntityBounds(entity);
           if (bounds) {
             const width = bounds.maxX - bounds.minX;
             const height = bounds.maxY - bounds.minY;
             return Math.max(width, height);
           }
        }

        // If open, calculate path length
        let len = 0;
        for (let i = 0; i < entity.vertices.length - 1; i++) {
          len += distance(entity.vertices[i], entity.vertices[i + 1]);
        }
        return len;
      }
      return 0;

    case EntityType.CIRCLE:
      if (entity.radius) {
        return 2 * Math.PI * entity.radius;
      }
      return 0;

    case EntityType.ARC:
      if (entity.radius && entity.startAngle !== undefined && entity.endAngle !== undefined) {
        // Angles are in degrees
        let diff = entity.endAngle - entity.startAngle;
        if (diff < 0) diff += 360;
        return (diff * Math.PI / 180) * entity.radius;
      }
      return 0;

    default:
      return 0;
  }
};

export const getEntityCoordinatesString = (entity: DxfEntity): string => {
  const round = (n: number) => Math.round(n * 100) / 100;
  const ptStr = (p: Point) => `(${round(p.x)}, ${round(p.y)})`;

  if (entity.type === EntityType.LINE && entity.start && entity.end) {
    return `${ptStr(entity.start)} → ${ptStr(entity.end)}`;
  } else if (entity.type === EntityType.LWPOLYLINE && entity.vertices && entity.vertices.length > 0) {
    return `${entity.vertices.length} pts, start: ${ptStr(entity.vertices[0])}`;
  } else if ((entity.type === EntityType.CIRCLE || entity.type === EntityType.ARC) && entity.center && entity.radius) {
    return `Center: ${ptStr(entity.center)}, R: ${round(entity.radius)}`;
  }
  return "N/A";
};
