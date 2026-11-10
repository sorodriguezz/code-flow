import { rgba } from "./finish";
import { mix, type Rgb } from "./palette";

export type Point3 = readonly [number, number, number];
export type Solid = readonly [Point3, Point3];
type Face = { points: Point3[]; color: Rgb; light: number };
type ProjectedFace = { points: Point3[]; color: string; depth: number };
type SurfaceFace = { points: Point3[]; light: number };

const ZERO = 0;
const ONE = 1;
const TWO = 2;
const HALF = 0.5;
const X = 0;
const Y = 1;
const Z = 2;
const FIRST = 0;
const NEXT = 1;
const MINIMUM_FACE_AREA = 0.000001;
const FULL_TURN = Math.PI * TWO;
const AMBIENT_LIGHT = 0.64;
const DIFFUSE_LIGHT = 0.36;
const LIGHT_DIRECTION: Point3 = [-0.4, -0.65, 0.65];
const BLACK: Rgb = [0, 0, 0];
const EDGE_WIDTH = 0.001;
const ROUND_JOIN = "round";
const BOX_CORNERS: readonly Point3[] = [
  [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
  [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];
const BOX_FACES = [
  { indices: [0, 3, 2, 1], normal: [0, 0, -1] },
  { indices: [4, 5, 6, 7], normal: [0, 0, 1] },
  { indices: [0, 4, 7, 3], normal: [-1, 0, 0] },
  { indices: [1, 2, 6, 5], normal: [1, 0, 0] },
  { indices: [0, 1, 5, 4], normal: [0, -1, 0] },
  { indices: [3, 7, 6, 2], normal: [0, 1, 0] },
] as const;
const ORIGIN: Point3 = [0, 0, 0];
const ELLIPSOID_SURFACES = new Map<number, readonly SurfaceFace[]>();

function pointRotation(pivot: Point3, angles: Point3): (point: Point3) => Point3 {
  const [pitch, yaw, roll] = angles;
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  const cr = Math.cos(roll);
  const sr = Math.sin(roll);
  return (point) => {
    const dx = point[X] - pivot[X];
    const dy = point[Y] - pivot[Y];
    const dz = point[Z] - pivot[Z];
    const turnedX = dx * cy + dz * sy;
    const turnedZ = dz * cy - dx * sy;
    const pitchedY = dy * cp - turnedZ * sp;
    const pitchedZ = dy * sp + turnedZ * cp;
    return [turnedX * cr - pitchedY * sr + pivot[X], turnedX * sr + pitchedY * cr + pivot[Y], pitchedZ + pivot[Z]];
  };
}

function ellipsoidSurface(segments: number, dome: boolean): readonly SurfaceFace[] {
  const key = dome ? -segments : segments;
  const cached = ELLIPSOID_SURFACES.get(key);
  if (cached) return cached;
  const faces: SurfaceFace[] = [];
  const rings = segments / TWO;
  const latitudeRange = dome ? Math.PI * HALF : Math.PI;
  for (let ring = ZERO; ring < rings; ring += ONE) {
    const startLatitude = ring / rings * latitudeRange;
    const endLatitude = (ring + ONE) / rings * latitudeRange;
    for (let segment = ZERO; segment < segments; segment += ONE) {
      const startLongitude = segment / segments * FULL_TURN;
      const endLongitude = (segment + ONE) / segments * FULL_TURN;
      const coordinates = [
        [startLatitude, startLongitude], [endLatitude, startLongitude],
        [endLatitude, endLongitude], [startLatitude, endLongitude],
      ];
      const points = coordinates.map(([latitude, longitude]): Point3 => {
        const sinLatitude = Math.sin(latitude);
        const cosLatitude = Math.cos(latitude);
        const sinLongitude = Math.sin(longitude);
        const cosLongitude = Math.cos(longitude);
        return [sinLatitude * cosLongitude, -cosLatitude, sinLatitude * sinLongitude];
      });
      const middleLatitude = (startLatitude + endLatitude) * HALF;
      const middleLongitude = (startLongitude + endLongitude) * HALF;
      const sinMiddle = Math.sin(middleLatitude);
      const cosMiddle = Math.cos(middleLatitude);
      const cosLongitude = Math.cos(middleLongitude);
      const sinLongitude = Math.sin(middleLongitude);
      const normal: Point3 = [sinMiddle * cosLongitude, -cosMiddle, sinMiddle * sinLongitude];
      const light = illumination(normal);
      faces.push({ points, light });
    }
  }
  ELLIPSOID_SURFACES.set(key, faces);
  return faces;
}

function illumination(normal: Point3): number {
  const dot = normal[X] * LIGHT_DIRECTION[X] + normal[Y] * LIGHT_DIRECTION[Y] + normal[Z] * LIGHT_DIRECTION[Z];
  const lit = Math.max(ZERO, dot);
  return AMBIENT_LIGHT + DIFFUSE_LIGHT * lit;
}

export class CharacterMesh {
  private readonly faces: Face[] = [];

  constructor(private readonly segments: number) {}

  polygon(points: Point3[], color: Rgb, normal: Point3 = LIGHT_DIRECTION) {
    const light = illumination(normal);
    this.faces.push({ points, color, light });
  }

  box([center, size]: Solid, color: Rgb) {
    const points = BOX_CORNERS.map((corner): Point3 => [
      center[X] + corner[X] * size[X] * HALF,
      center[Y] + corner[Y] * size[Y] * HALF,
      center[Z] + corner[Z] * size[Z] * HALF,
    ]);
    for (const face of BOX_FACES) {
      const vertices = face.indices.map((index) => points[index]);
      this.polygon(vertices, color, face.normal);
    }
  }

  ellipsoid([center, radius]: Solid, color: Rgb, dome = false) {
    const surface = ellipsoidSurface(this.segments, dome);
    for (const face of surface) {
      const points = face.points.map((point): Point3 => [center[X] + point[X] * radius[X], center[Y] + point[Y] * radius[Y], center[Z] + point[Z] * radius[Z]]);
      this.faces.push({ points, color, light: face.light });
    }
  }

  cylinder([center, size]: Solid, color: Rgb) {
    const top = center[Y] - size[Y] * HALF;
    const bottom = center[Y] + size[Y] * HALF;
    const cap: Point3[] = [];
    for (let segment = ZERO; segment < this.segments; segment += ONE) {
      const from = segment / this.segments * FULL_TURN;
      const to = (segment + ONE) / this.segments * FULL_TURN;
      const cosFrom = Math.cos(from);
      const sinFrom = Math.sin(from);
      const cosTo = Math.cos(to);
      const sinTo = Math.sin(to);
      const left = center[X] + cosFrom * size[X];
      const front = center[Z] + sinFrom * size[Z];
      const right = center[X] + cosTo * size[X];
      const back = center[Z] + sinTo * size[Z];
      const middle = (from + to) * HALF;
      const nx = Math.cos(middle);
      const nz = Math.sin(middle);
      const normal: Point3 = [nx, ZERO, nz];
      const points: Point3[] = [[left, top, front], [left, bottom, front], [right, bottom, back], [right, top, back]];
      const capPoint: Point3 = [left, top, front];
      cap.push(capPoint);
      this.polygon(points, color, normal);
    }
    const capNormal: Point3 = [ZERO, -ONE, ZERO];
    this.polygon(cap, color, capNormal);
    const bottomCap = cap.map(([x, , z]): Point3 => [x, bottom, z]);
    bottomCap.reverse();
    const bottomNormal: Point3 = [ZERO, ONE, ZERO];
    this.polygon(bottomCap, color, bottomNormal);
  }

  group(pivot: Point3, angles: Point3, build: () => void) {
    const start = this.faces.length;
    const rotate = pointRotation(pivot, angles);
    build();
    for (let index = start; index < this.faces.length; index += ONE) {
      const face = this.faces[index];
      face.points = face.points.map(rotate);
    }
  }

  paint(ctx: CanvasRenderingContext2D, px: number, angles: Point3, offset: Point3, scale: number, tint: Rgb, tintAmount: number, alpha: number) {
    const projected: ProjectedFace[] = [];
    const rotate = pointRotation(ORIGIN, angles);
    for (const face of this.faces) {
      const points = face.points.map((point): Point3 => {
        const rotated = rotate(point);
        return [(HALF + offset[X] + rotated[X] * scale) * px, (HALF + offset[Y] + rotated[Y] * scale) * px, rotated[Z]];
      });
      let area = ZERO;
      const pointCount = points.length;
      for (let index = ZERO; index < pointCount; index += ONE) {
        const point = points[index];
        const next = points[(index + ONE) % pointCount];
        area += point[X] * next[Y] - next[X] * point[Y];
      }
      if (area <= MINIMUM_FACE_AREA) continue;
      const depthSum = points.reduce((sum, point) => sum + point[Z], ZERO);
      const depth = depthSum / points.length;
      const shaded = mix(BLACK, face.color, face.light);
      const tinted = mix(shaded, tint, tintAmount);
      const color = rgba(tinted, alpha);
      projected.push({ points, color, depth });
    }
    projected.sort((left, right) => left.depth - right.depth);
    ctx.lineWidth = px * EDGE_WIDTH;
    ctx.lineJoin = ROUND_JOIN;
    for (const face of projected) {
      const first = face.points[FIRST];
      const rest = face.points.slice(NEXT);
      ctx.beginPath();
      ctx.moveTo(first[X], first[Y]);
      for (const point of rest) ctx.lineTo(point[X], point[Y]);
      ctx.closePath();
      ctx.fillStyle = face.color;
      ctx.strokeStyle = face.color;
      ctx.fill();
      ctx.stroke();
    }
  }
}
