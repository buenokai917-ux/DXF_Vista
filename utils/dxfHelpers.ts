
import { DxfEntity, EntityType, Point } from '../types';
import { transformPoint } from './geometryUtils';

// Recursively extract entities from layers, transforming block coordinates to world space
export const extractEntities = (
    targetLayers: string[], 
    rootEntities: DxfEntity[], 
    blocks: Record<string, DxfEntity[]>, 
    blockBasePoints: Record<string, Point>
): DxfEntity[] => {
    const extracted: DxfEntity[] = [];
    
    const recurse = (entities: DxfEntity[], transform: { scale: Point, rotation: number, translation: Point }, parentLayer: string | null) => {
        entities.forEach(ent => {
           // Layer Inheritance: If entity is on Layer 0, use parent layer (if inside a block)
           const effectiveLayer = (ent.layer === '0' && parentLayer) ? parentLayer : ent.layer;

           // 1. Recursion into Blocks
           if (ent.type === EntityType.INSERT && ent.blockName && blocks[ent.blockName]) {
               const basePoint = blockBasePoints[ent.blockName] || { x: 0, y: 0 };
               
               // Handle MINSERT (rows/cols)
               const rows = ent.rowCount || 1;
               const cols = ent.columnCount || 1;
               const rSpace = ent.rowSpacing || 0;
               const cSpace = ent.columnSpacing || 0;
               
               const baseScaleX = transform.scale.x * (ent.scale?.x || 1);
               const baseScaleY = transform.scale.y * (ent.scale?.y || 1);
               const baseRotation = transform.rotation + (ent.rotation || 0);

               for (let r = 0; r < rows; r++) {
                   for (let c = 0; c < cols; c++) {
                       let gridX = c * cSpace;
                       let gridY = r * rSpace;
                       let rotGridX = gridX;
                       let rotGridY = gridY;

                       if (ent.rotation) {
                          const rad = ent.rotation * Math.PI / 180;
                          rotGridX = gridX * Math.cos(rad) - gridY * Math.sin(rad);
                          rotGridY = gridX * Math.sin(rad) + gridY * Math.cos(rad);
                       }

                       const localInsX = (ent.start?.x || 0) + rotGridX;
                       const localInsY = (ent.start?.y || 0) + rotGridY;
                       const tPos = transformPoint({x: localInsX, y: localInsY}, transform.scale, transform.rotation, transform.translation);
                       const tBase = transformPoint(basePoint, {x: baseScaleX, y: baseScaleY}, baseRotation, {x:0, y:0});
                       
                       const finalTrans = {
                           x: tPos.x - tBase.x,
                           y: tPos.y - tBase.y
                       };

                       recurse(blocks[ent.blockName!], {
                          scale: { x: baseScaleX, y: baseScaleY },
                          rotation: baseRotation,
                          translation: finalTrans
                       }, effectiveLayer);
                   }
               }
               return;
           }
           // 2. Collection of Target Entities
           if (targetLayers.includes(effectiveLayer)) {
               const worldEnt = { ...ent, layer: effectiveLayer };
               if (worldEnt.start) worldEnt.start = transformPoint(worldEnt.start, transform.scale, transform.rotation, transform.translation);
               if (worldEnt.end) worldEnt.end = transformPoint(worldEnt.end, transform.scale, transform.rotation, transform.translation);
               if (worldEnt.center) worldEnt.center = transformPoint(worldEnt.center, transform.scale, transform.rotation, transform.translation);
               if (worldEnt.vertices) {
                   worldEnt.vertices = worldEnt.vertices.map(v => transformPoint(v, transform.scale, transform.rotation, transform.translation));
               }
               if (worldEnt.startAngle !== undefined) worldEnt.startAngle += transform.rotation;
               if (worldEnt.endAngle !== undefined) worldEnt.endAngle += transform.rotation;
               if (worldEnt.measureStart) worldEnt.measureStart = transformPoint(worldEnt.measureStart, transform.scale, transform.rotation, transform.translation);
               if (worldEnt.measureEnd) worldEnt.measureEnd = transformPoint(worldEnt.measureEnd, transform.scale, transform.rotation, transform.translation);

               extracted.push(worldEnt);
           }
        });
    };
    recurse(rootEntities, { scale: {x:1, y:1}, rotation: 0, translation: {x:0, y:0} }, null);
    return extracted;
};
