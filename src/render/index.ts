import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { hashSeed, mulberry32 } from '../engine/rng';
import type { BuildingDef, DayRecord, DistrictDef, EdgeDef, NodeDef } from '../engine/types';
import type { CreateRenderApp, PickTarget, RenderApp, RenderMode } from './types';

const WORLD_SCALE = 1.15;
const ROAD_WIDTH = 6;
const BUILDING_SPACING = 9;
const PICK_DISTANCE = 42;

// Files under public/ are served at the app root; base handles './' deploys.
const MODEL_BASE = `${import.meta.env.BASE_URL}assets/models/`;

/**
 * Kind -> candidate model files; a stable per-building hash picks one.
 * Paths are kit-relative so each kit keeps its own Textures/colormap.png
 * (the three Kenney kits ship different atlases under the same filename).
 */
const BUILDING_MODELS: Record<BuildingDef['kind'], string[]> = {
  shop: ['commercial/shop-a.glb', 'commercial/shop-b.glb', 'commercial/shop-c.glb'],
  depot: ['commercial/depot.glb'],
  warehouse: ['commercial/warehouse-a.glb', 'commercial/warehouse-b.glb'],
  datacenter: ['commercial/datacenter.glb'],
  civic: ['commercial/civic-a.glb', 'commercial/civic-b.glb'],
  housing: [
    'suburban/house-a.glb',
    'suburban/house-b.glb',
    'suburban/house-c.glb',
    'suburban/house-d.glb',
    'suburban/house-e.glb',
  ],
  // sensorStation is drawn procedurally; plaza is dressed with trees.
  sensorStation: [],
  plaza: [],
};

const VEHICLE_MODELS = [
  'car/car-sedan.glb',
  'car/car-suv.glb',
  'car/car-hatchback.glb',
  'car/car-taxi.glb',
  'car/car-van.glb',
];
const TRUCK_MODEL = 'car/truck.glb';
const TRUCK_SPECIAL_MODEL = 'car/truck-delivery.glb';
const DRESSING_MODELS = ['suburban/tree-large.glb', 'suburban/tree-small.glb', 'suburban/planter.glb'];

/** Target world footprint (max of x/z) per kind, used to normalize model scale. */
function footprintForKind(kind: BuildingDef['kind']): number {
  switch (kind) {
    case 'datacenter':
      return 13;
    case 'warehouse':
      return 13;
    case 'depot':
      return 14;
    case 'plaza':
      return 12;
    case 'housing':
      return 7;
    default:
      return 8;
  }
}

/** Per-kind tint multiplied into the model's atlas texture to reinforce identity. */
function tintForKind(kind: BuildingDef['kind']): THREE.Color {
  switch (kind) {
    case 'depot':
      return new THREE.Color(0x9fc2da);
    case 'warehouse':
      return new THREE.Color(0xcbb98f);
    case 'datacenter':
      return new THREE.Color(0xe89a8c);
    case 'sensorStation':
      return new THREE.Color(0x8fded4);
    case 'civic':
      return new THREE.Color(0xcdd4e2);
    case 'plaza':
      return new THREE.Color(0x9fd08a);
    case 'shop':
      return new THREE.Color(0xf0d79c);
    case 'housing':
      return new THREE.Color(0xc2ccd6);
  }
}

function planToWorld(n: Pick<NodeDef, 'x' | 'y'>): THREE.Vector3 {
  return new THREE.Vector3((n.x - 120) * WORLD_SCALE, 0, (n.y - 80) * WORLD_SCALE);
}

function equalTarget(a: PickTarget, b: PickTarget): boolean {
  return a?.kind === b?.kind && a?.id === b?.id;
}

type Targeted = THREE.Object3D & { userData: { pick?: Exclude<PickTarget, null> } };
type TargetedMesh = THREE.Mesh & { userData: { pick?: Exclude<PickTarget, null> } };

/** A road-dash centerline texture so procedural road boxes read as streets. */
function makeRoadTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#3d444b';
  ctx.fillRect(0, 0, 64, 256);
  // subtle asphalt grain
  ctx.fillStyle = 'rgba(255,255,255,0.03)';
  for (let i = 0; i < 220; i++) ctx.fillRect(Math.random() * 64, Math.random() * 256, 1, 1);
  // edge lines
  ctx.fillStyle = 'rgba(226,232,222,0.5)';
  ctx.fillRect(4, 0, 2, 256);
  ctx.fillRect(58, 0, 2, 256);
  // dashed center line
  ctx.fillStyle = 'rgba(247,213,120,0.85)';
  for (let y = 0; y < 256; y += 48) ctx.fillRect(30, y, 4, 26);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** A vertical gradient sky dome. */
function makeSky(top: number, bottom: number): THREE.Mesh {
  const geo = new THREE.SphereGeometry(600, 24, 12);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(top) },
      bottom: { value: new THREE.Color(bottom) },
    },
    vertexShader: `varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `varying vec3 vP; uniform vec3 top; uniform vec3 bottom;
      void main(){ float h = clamp((normalize(vP).y*0.5)+0.5,0.0,1.0); gl_FragColor = vec4(mix(bottom, top, h),1.0); }`,
  });
  return new THREE.Mesh(geo, mat);
}

class DistrictRenderApp implements RenderApp {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly worldRoot = new THREE.Group();
  private readonly camera = new THREE.PerspectiveCamera(68, 1, 0.1, 1400);
  private readonly timer = new THREE.Timer();
  private readonly raycaster = new THREE.Raycaster();
  private readonly keys = new Set<string>();
  private readonly nodeById = new Map<string, NodeDef>();
  private readonly edgeById = new Map<string, EdgeDef>();
  private readonly pickables: Targeted[] = [];
  private readonly roadMeshes = new Map<string, THREE.Mesh>();
  private readonly buildingMeshes = new Map<string, THREE.Object3D>();
  private readonly trafficSprites: THREE.Object3D[] = [];
  private readonly deliverySprites: { mesh: THREE.Object3D; route: THREE.Vector3[]; phase: number }[] = [];
  private readonly loader = new GLTFLoader();
  private readonly modelCache = new Map<string, Promise<THREE.Object3D>>();
  private readonly sky: THREE.Mesh;
  private readonly skyMat: THREE.ShaderMaterial;
  private resizeObserver: ResizeObserver | null = null;
  private readonly pickCbs: ((t: PickTarget) => void)[] = [];
  private readonly lockCbs: ((locked: boolean) => void)[] = [];
  private readonly progressCbs: ((loaded: number, total: number) => void)[] = [];
  private running = false;
  private ready = false;
  private mode: RenderMode = 'world';
  private yaw = 0;
  private pitch = -0.18;
  private pick: PickTarget = null;
  private highlight: PickTarget = null;
  private dayData: DayRecord | null = null;
  private pendingDay: DayRecord | null = null;
  private truckProto: THREE.Object3D | null = null;
  private truckSpecialProto: THREE.Object3D | null = null;
  private loadProgress = 0;
  private loadTotal = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly district: DistrictDef,
  ) {
    for (const n of district.nodes) this.nodeById.set(n.id, n);
    for (const e of district.edges) this.edgeById.set(e.id, e);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    this.camera.position.set(-95, 28, -82);
    this.scene.add(this.worldRoot);
    this.sky = makeSky(0xdfeaf2, 0x8fb4c6);
    this.skyMat = this.sky.material as THREE.ShaderMaterial;
    this.scene.add(this.sky);
    this.buildStaticScene();
    void this.loadAssets();
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.resize());
      this.resizeObserver.observe(container);
    }
    this.timer.connect(document);
    this.resize();
    requestAnimationFrame(() => this.resize());
    window.addEventListener('resize', this.resize);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    document.addEventListener('mousemove', this.onMouseMove);
    document.addEventListener('pointerlockchange', this.onPointerLock);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.renderer.setAnimationLoop((time) => this.frame(time));
  }

  dispose(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
    this.resizeObserver?.disconnect();
    this.timer.dispose();
    this.renderer.domElement.remove();
    window.removeEventListener('resize', this.resize);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    document.removeEventListener('mousemove', this.onMouseMove);
    document.removeEventListener('pointerlockchange', this.onPointerLock);
  }

  onProgress(cb: (loaded: number, total: number) => void): void {
    this.progressCbs.push(cb);
    cb(this.loadProgress, this.loadTotal);
  }

  isReady(): boolean {
    return this.ready;
  }

  setMode(mode: RenderMode): void {
    this.mode = mode;
    const sandbox = mode === 'sandbox';
    const bgTop = sandbox ? 0x06222c : 0xdfeaf2;
    const bgBottom = sandbox ? 0x02080c : 0x8fb4c6;
    this.skyMat.uniforms.top!.value.setHex(bgTop);
    this.skyMat.uniforms.bottom!.value.setHex(bgBottom);
    this.scene.background = null;
    this.scene.fog = new THREE.Fog(sandbox ? 0x04121a : 0xbcd3de, 150, sandbox ? 320 : 520);
    for (const obj of [...this.roadMeshes.values(), ...this.buildingMeshes.values(), ...this.trafficSprites]) {
      obj.traverse((child) => {
        const mat = (child as THREE.Mesh).material;
        if (mat instanceof THREE.MeshStandardMaterial) {
          mat.wireframe = sandbox;
          mat.opacity = sandbox ? 0.66 : 1;
          mat.transparent = sandbox;
          mat.emissive.setHex(sandbox ? 0x0a4a5a : 0x000000);
        }
      });
    }
    this.applyHighlights();
  }

  setDayData(rec: DayRecord | null): void {
    this.dayData = rec;
    this.pendingDay = rec;
    for (const [id, mesh] of this.roadMeshes) {
      const ratio = rec?.congestion[id] ?? 0.65;
      const mat = mesh.material;
      if (mat instanceof THREE.MeshStandardMaterial) {
        mat.color.setHex(ratio > 1.05 ? 0xc96b5a : ratio > 0.85 ? 0xcaa96a : 0xffffff);
      }
    }
    this.rebuildDeliveries(rec);
  }

  getPickTarget(): PickTarget {
    return this.pick;
  }

  onPickChange(cb: (t: PickTarget) => void): void {
    this.pickCbs.push(cb);
  }

  setHighlight(t: PickTarget): void {
    this.highlight = t;
    this.applyHighlights();
  }

  lock(): void {
    void this.renderer.domElement.requestPointerLock();
  }

  unlock(): void {
    if (document.pointerLockElement === this.renderer.domElement) document.exitPointerLock();
  }

  isLocked(): boolean {
    return document.pointerLockElement === this.renderer.domElement;
  }

  onLockChange(cb: (locked: boolean) => void): void {
    this.lockCbs.push(cb);
  }

  // --- Scene construction -----------------------------------------------------

  private buildStaticScene(): void {
    this.scene.fog = new THREE.Fog(0xbcd3de, 150, 520);
    const hemi = new THREE.HemisphereLight(0xf4f9ff, 0x54604f, 1.9);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff3dc, 2.2);
    sun.position.set(90, 140, 40);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xbcd4ff, 0.5);
    fill.position.set(-70, 60, -50);
    this.scene.add(fill);

    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(1200, 900),
      new THREE.MeshStandardMaterial({ color: 0x5c6b5f, roughness: 0.98, metalness: 0 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    this.worldRoot.add(ground);

    // district plot pad (slightly lighter, gives the built area definition)
    const pad = new THREE.Mesh(
      new THREE.PlaneGeometry(360, 260),
      new THREE.MeshStandardMaterial({ color: 0x6a786c, roughness: 0.97 }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0;
    this.worldRoot.add(pad);

    const roadTex = makeRoadTexture();
    for (const e of this.district.edges) this.addRoad(e, roadTex);
    for (const b of this.district.buildings) {
      if (b.kind === 'sensorStation') this.addSensorStation(b);
    }
    this.addCrosshair();
  }

  private addRoad(e: EdgeDef, tex: THREE.CanvasTexture): void {
    const a = this.nodeById.get(e.a);
    const b = this.nodeById.get(e.b);
    if (!a || !b) return;
    const pa = planToWorld(a);
    const pb = planToWorld(b);
    const mid = pa.clone().lerp(pb, 0.5);
    const length = pa.distanceTo(pb);
    const roadTex = tex.clone();
    roadTex.needsUpdate = true;
    roadTex.repeat.set(1, Math.max(1, Math.round(length / 8)));
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(ROAD_WIDTH, 0.22, length),
      new THREE.MeshStandardMaterial({ color: 0xffffff, map: roadTex, roughness: 0.9, metalness: 0 }),
    ) as TargetedMesh;
    mesh.position.copy(mid);
    mesh.position.y = 0.06;
    mesh.rotation.y = Math.atan2(pb.x - pa.x, pb.z - pa.z);
    mesh.userData.pick = { kind: 'road', id: e.id };
    this.worldRoot.add(mesh);
    this.pickables.push(mesh);
    this.roadMeshes.set(e.id, mesh);
  }

  /** Procedural instrument mast — no kit model reads as a sensor tower. */
  private addSensorStation(b: BuildingDef): void {
    const n = this.nodeById.get(b.node);
    if (!n) return;
    const group = new THREE.Group() as Targeted;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.5, 0.7, 11, 8),
      new THREE.MeshStandardMaterial({ color: 0x9aa6ad, roughness: 0.6, metalness: 0.3 }),
    );
    pole.position.y = 5.5;
    const head = new THREE.Mesh(
      new THREE.BoxGeometry(2.6, 1.4, 2.6),
      new THREE.MeshStandardMaterial({ color: 0x2f3b40, roughness: 0.5, metalness: 0.2 }),
    );
    head.position.y = 11.4;
    const eye = new THREE.Mesh(
      new THREE.SphereGeometry(0.7, 12, 8),
      new THREE.MeshStandardMaterial({ color: 0x9fded4, emissive: 0x2f7d75, emissiveIntensity: 0.8, roughness: 0.3 }),
    );
    eye.position.set(0, 11.4, 1.3);
    const arm = new THREE.Mesh(
      new THREE.BoxGeometry(6, 0.35, 0.35),
      new THREE.MeshStandardMaterial({ color: 0x9aa6ad, roughness: 0.6, metalness: 0.3 }),
    );
    arm.position.y = 9.6;
    for (const part of [pole, head, eye, arm]) {
      (part as Targeted).userData.pick = { kind: 'building', id: b.id };
      this.pickables.push(part as Targeted);
      group.add(part);
    }
    group.userData.pick = { kind: 'building', id: b.id };
    group.position.copy(this.placementFor(b));
    this.worldRoot.add(group);
    this.buildingMeshes.set(b.id, group);
  }

  /** Deterministic offset from a node so co-located buildings do not overlap. */
  private placementFor(b: BuildingDef): THREE.Vector3 {
    const n = this.nodeById.get(b.node)!;
    const base = planToWorld(n);
    const hash = [...b.id].reduce((s, c) => s + c.charCodeAt(0), 0);
    const angle = (hash % 8) * (Math.PI / 4);
    return base.add(new THREE.Vector3(Math.cos(angle) * BUILDING_SPACING, 0, Math.sin(angle) * BUILDING_SPACING));
  }

  private addCrosshair(): void {
    const reticle = document.createElement('div');
    reticle.className = 'reticle';
    this.container.appendChild(reticle);
  }

  // --- Async asset loading ----------------------------------------------------

  private async loadModel(file: string): Promise<THREE.Object3D> {
    let p = this.modelCache.get(file);
    if (!p) {
      const url = `${MODEL_BASE}${file}`;
      p = this.loader.loadAsync(url).then((g) => g.scene);
      this.modelCache.set(file, p);
    }
    return (await p).clone(true);
  }

  private async loadAssets(): Promise<void> {
    const buildings = this.district.buildings.filter(
      (b) => b.kind !== 'sensorStation' && b.kind !== 'plaza' && BUILDING_MODELS[b.kind].length > 0,
    );
    const plazas = this.district.buildings.filter((b) => b.kind === 'plaza');
    // total loadable units: buildings + trucks + ambient cars + plaza dressing
    this.loadTotal = buildings.length + 2 + this.trafficSprites.length; // trucks(2)
    const CAR_COUNT = 44;
    this.loadTotal += CAR_COUNT + plazas.length;
    this.emitProgress();

    // Vehicle prototypes first so delivery playback works ASAP.
    const [truck, special, ...cars] = await Promise.all([
      this.loadModel(TRUCK_MODEL),
      this.loadModel(TRUCK_SPECIAL_MODEL),
      ...VEHICLE_MODELS.map((m) => this.loadModel(m)),
    ]);
    this.truckProto = truck!;
    this.truckSpecialProto = special!;
    this.tintTruck(this.truckProto, 0xdfe5ea);
    this.tintTruck(this.truckSpecialProto, 0xf7c857);
    this.step(2);

    // Buildings.
    for (const b of buildings) {
      const files = BUILDING_MODELS[b.kind];
      const hash = [...b.id].reduce((s, c) => s + c.charCodeAt(0), 0);
      const file = files[hash % files.length]!;
      const model = await this.loadModel(file);
      this.placeBuilding(b, model);
      this.step(1);
    }

    // Plaza dressing (trees + planters, non-pickable ground clutter).
    for (const b of plazas) {
      await this.dressPlaza(b);
      this.step(1);
    }

    // Ambient traffic cars.
    for (let i = 0; i < CAR_COUNT; i++) {
      const proto = cars[i % cars.length]!;
      const car = proto.clone(true);
      this.prepMaterials(car, undefined, true);
      this.normalizeCar(car);
      car.visible = false;
      this.worldRoot.add(car);
      this.trafficSprites.push(car);
      this.step(1);
    }

    this.ready = true;
    // Apply any state that arrived before models existed.
    this.setMode(this.mode);
    if (this.pendingDay !== null || this.dayData !== null) this.setDayData(this.pendingDay ?? this.dayData);
    this.applyHighlights();
    this.emitProgress();
  }

  private placeBuilding(b: BuildingDef, model: THREE.Object3D): void {
    const group = new THREE.Group() as Targeted;
    this.normalizeBuilding(model, b.kind);
    this.prepMaterials(model, tintForKind(b.kind), false, { kind: 'building', id: b.id });
    group.add(model);
    group.userData.pick = { kind: 'building', id: b.id };
    group.position.copy(this.placementFor(b));
    const hash = [...b.id].reduce((s, c) => s + c.charCodeAt(0), 0);
    group.rotation.y = (hash % 4) * (Math.PI / 2);
    this.worldRoot.add(group);
    this.buildingMeshes.set(b.id, group);
  }

  private async dressPlaza(b: BuildingDef): Promise<void> {
    const group = new THREE.Group();
    const center = this.placementFor(b);
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(9, 24),
      new THREE.MeshStandardMaterial({ color: 0x7f8a76, roughness: 0.95 }),
    );
    pad.rotation.x = -Math.PI / 2;
    pad.position.y = 0.05;
    group.add(pad);
    const rng = mulberry32(hashSeed(`plaza|${b.id}`));
    for (let i = 0; i < 10; i++) {
      const file = DRESSING_MODELS[Math.floor(rng() * DRESSING_MODELS.length)]!;
      const item = await this.loadModel(file);
      const scale = 4 + rng() * 2;
      item.scale.setScalar(scale);
      this.prepMaterials(item, undefined, false);
      const ang = rng() * Math.PI * 2;
      const rad = 3 + rng() * 5;
      item.position.set(Math.cos(ang) * rad, 0, Math.sin(ang) * rad);
      group.add(item);
    }
    group.position.copy(center);
    this.worldRoot.add(group);
    this.buildingMeshes.set(b.id, group);
  }

  // --- Model normalization ----------------------------------------------------

  private measure(obj: THREE.Object3D): THREE.Box3 {
    obj.updateMatrixWorld(true);
    return new THREE.Box3().setFromObject(obj);
  }

  private normalizeBuilding(model: THREE.Object3D, kind: BuildingDef['kind']): void {
    const box = this.measure(model);
    const size = new THREE.Vector3();
    box.getSize(size);
    const footprint = Math.max(size.x, size.z, 0.001);
    const scale = footprintForKind(kind) / footprint;
    model.scale.setScalar(scale);
    // re-measure after scaling to seat on the ground and center on x/z
    const b2 = this.measure(model);
    model.position.x -= (b2.min.x + b2.max.x) / 2;
    model.position.z -= (b2.min.z + b2.max.z) / 2;
    model.position.y -= b2.min.y;
  }

  private normalizeCar(car: THREE.Object3D): void {
    car.scale.setScalar(2.2);
    const box = this.measure(car);
    // seat wheels on the road surface
    car.position.y -= box.min.y;
  }

  private tintTruck(truck: THREE.Object3D, hex: number): void {
    truck.scale.setScalar(2.4);
    const box = this.measure(truck);
    truck.position.y -= box.min.y;
    this.prepMaterials(truck, new THREE.Color(hex), true);
  }

  /**
   * Ensure standard materials, give each object its own material (so highlight
   * and sandbox tinting are independent), and optionally apply a color tint and
   * a pick tag on every child mesh.
   */
  private prepMaterials(
    obj: THREE.Object3D,
    tint: THREE.Color | undefined,
    shareOk: boolean,
    pick?: Exclude<PickTarget, null>,
  ): void {
    const shared = new WeakMap<THREE.Material, THREE.Material>();
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh) return;
      const src = mesh.material;
      const clone = (m: THREE.Material): THREE.Material => {
        if (shareOk) {
          const existing = shared.get(m);
          if (existing) return existing;
          const c = m.clone();
          shared.set(m, c);
          return c;
        }
        return m.clone();
      };
      const apply = (m: THREE.Material): THREE.Material => {
        const c = clone(m) as THREE.MeshStandardMaterial;
        if (tint && 'color' in c) c.color.multiply(tint);
        if ('roughness' in c) c.roughness = Math.min(1, (c.roughness ?? 0.8) + 0.05);
        return c;
      };
      mesh.material = Array.isArray(src) ? src.map(apply) : apply(src);
      if (pick) (mesh as TargetedMesh).userData.pick = pick;
    });
    if (pick) this.pickables.push(obj as Targeted);
  }

  private rebuildDeliveries(rec: DayRecord | null): void {
    for (const del of this.deliverySprites) this.worldRoot.remove(del.mesh);
    this.deliverySprites.length = 0;
    if (!rec || !this.truckProto || !this.truckSpecialProto) return;
    for (const [i, d] of rec.deliveries.filter((delivery) => delivery.delivered).slice(0, 24).entries()) {
      const route = d.route.flatMap((edgeId) => {
        const e = this.edgeById.get(edgeId);
        const a = e ? this.nodeById.get(e.a) : undefined;
        return a ? [planToWorld(a)] : [];
      });
      const lastEdge = this.edgeById.get(d.route[d.route.length - 1] ?? '');
      const lastNode = lastEdge ? this.nodeById.get(lastEdge.b) : undefined;
      if (lastNode) route.push(planToWorld(lastNode));
      if (route.length > 1) {
        const proto = d.to === 'W7' ? this.truckSpecialProto : this.truckProto;
        const mesh = proto.clone(true);
        mesh.traverse((c) => {
          const m = (c as THREE.Mesh).material;
          if (m instanceof THREE.MeshStandardMaterial) {
            m.wireframe = this.mode === 'sandbox';
            m.transparent = this.mode === 'sandbox';
            m.opacity = this.mode === 'sandbox' ? 0.66 : 1;
          }
        });
        this.worldRoot.add(mesh);
        const rng = mulberry32(hashSeed(`${rec.day}|${i}|${d.from}|${d.to}|${d.good}|${d.amount}|${d.reason}|${d.route.join(',')}`));
        this.deliverySprites.push({ mesh, route, phase: rng() });
      }
    }
  }

  // --- Loading progress -------------------------------------------------------

  private step(n: number): void {
    this.loadProgress += n;
    this.emitProgress();
  }

  private emitProgress(): void {
    for (const cb of this.progressCbs) cb(this.loadProgress, this.loadTotal);
  }

  // --- Frame ------------------------------------------------------------------

  private frame(time?: number): void {
    this.timer.update(time);
    const dt = Math.min(0.04, this.timer.getDelta());
    this.moveCamera(dt);
    this.animateTraffic(performance.now() / 1000);
    this.updatePick();
    this.renderer.render(this.scene, this.camera);
  }

  private moveCamera(dt: number): void {
    this.camera.rotation.order = 'YXZ';
    this.camera.rotation.y = this.yaw;
    this.camera.rotation.x = this.pitch;
    if (!this.isLocked()) return;
    const speed = (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') ? 38 : 24) * dt;
    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    if (this.keys.has('KeyW')) this.camera.position.addScaledVector(forward, speed);
    if (this.keys.has('KeyS')) this.camera.position.addScaledVector(forward, -speed);
    if (this.keys.has('KeyD')) this.camera.position.addScaledVector(right, speed);
    if (this.keys.has('KeyA')) this.camera.position.addScaledVector(right, -speed);
    if (this.keys.has('Space')) this.camera.position.y += speed;
    if (this.keys.has('KeyQ')) this.camera.position.y -= speed;
    if (this.keys.has('KeyE')) this.camera.position.y += speed;
    this.camera.position.y = THREE.MathUtils.clamp(this.camera.position.y, 5, 70);
    this.camera.position.x = THREE.MathUtils.clamp(this.camera.position.x, -170, 170);
    this.camera.position.z = THREE.MathUtils.clamp(this.camera.position.z, -120, 130);
    this.sky.position.copy(this.camera.position);
  }

  private animateTraffic(t: number): void {
    const edges = this.district.edges;
    for (let i = 0; i < this.trafficSprites.length; i++) {
      const edge = edges[i % edges.length];
      if (!edge) continue;
      const a = this.nodeById.get(edge.a);
      const b = this.nodeById.get(edge.b);
      if (!a || !b) continue;
      const ratio = this.dayData?.congestion[edge.id] ?? 0.7;
      const p = (t * (0.08 + ratio * 0.06) + i * 0.137) % 1;
      const pa = planToWorld(a);
      const pb = planToWorld(b);
      const mesh = this.trafficSprites[i]!;
      const pos = pa.clone().lerp(pb, p);
      // ride a lane offset to the right of centerline
      const dir = pb.clone().sub(pa).normalize();
      const lane = new THREE.Vector3(-dir.z, 0, dir.x).multiplyScalar(1.4);
      mesh.position.copy(pos).add(lane);
      mesh.position.y = 0.14;
      mesh.rotation.y = Math.atan2(pb.x - pa.x, pb.z - pa.z);
      mesh.visible = ratio > 0.18;
    }
    for (const del of this.deliverySprites) {
      const f = (t * 0.18 + del.phase) % 1;
      const idx = Math.min(del.route.length - 2, Math.floor(f * (del.route.length - 1)));
      const local = f * (del.route.length - 1) - idx;
      const a = del.route[idx];
      const b = del.route[idx + 1];
      if (!a || !b) continue;
      del.mesh.position.copy(a.clone().lerp(b, local));
      del.mesh.position.y = 0.16;
      del.mesh.rotation.y = Math.atan2(b.x - a.x, b.z - a.z);
    }
  }

  private updatePick(): void {
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hit = this.raycaster.intersectObjects(this.pickables, true).find((h) => h.distance <= PICK_DISTANCE);
    let obj: THREE.Object3D | undefined = hit?.object;
    let next: PickTarget = null;
    while (obj) {
      const p = (obj as Targeted).userData?.pick;
      if (p) {
        next = p;
        break;
      }
      obj = obj.parent ?? undefined;
    }
    if (!equalTarget(this.pick, next)) {
      this.pick = next;
      for (const cb of this.pickCbs) cb(next);
      this.applyHighlights();
    }
  }

  private applyHighlights(): void {
    const selected = this.highlight ?? this.pick;
    for (const [id, mesh] of this.roadMeshes) this.setEmissive(mesh, equalTarget(selected, { kind: 'road', id }) ? 0x4a6a2c : this.mode === 'sandbox' ? 0x0a4a5a : 0);
    for (const [id, obj] of this.buildingMeshes) {
      const on = equalTarget(selected, { kind: 'building', id });
      obj.traverse((child) => this.setEmissive(child, on ? 0x3a5226 : this.mode === 'sandbox' ? 0x0a4a5a : 0));
    }
  }

  private setEmissive(obj: THREE.Object3D, hex: number): void {
    const mat = (obj as THREE.Mesh).material;
    if (mat instanceof THREE.MeshStandardMaterial) mat.emissive.setHex(hex);
    else if (Array.isArray(mat)) for (const m of mat) if (m instanceof THREE.MeshStandardMaterial) m.emissive.setHex(hex);
  }

  private readonly resize = (): void => {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h, false);
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    this.keys.add(e.code);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    this.keys.delete(e.code);
  };

  private readonly onMouseMove = (e: MouseEvent): void => {
    if (!this.isLocked()) return;
    this.yaw -= e.movementX * 0.0022;
    this.pitch = THREE.MathUtils.clamp(this.pitch - e.movementY * 0.0022, -1.25, 0.85);
  };

  private readonly onPointerLock = (): void => {
    for (const cb of this.lockCbs) cb(this.isLocked());
  };
}

export const createRenderApp: CreateRenderApp = (container, district) => new DistrictRenderApp(container, district);
