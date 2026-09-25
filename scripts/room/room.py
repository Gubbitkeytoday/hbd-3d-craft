"""
Party room: assemble, light, bake and export (Blender 5.2, headless).

Full pipeline (reproducible; cache/ is git-ignored):
    npm run room:fetch            Poly Haven CC0 downloads + night-city image
    blender ... room.py -- build | bake --size 2048 --samples 1536 | export
    node scratchpad harness       (optional) props.glb from the runtime for posters
    blender ... room.py -- poster
    npm run room:optimize         public/room/*.glb/webp, room.json, CREDITS.md

    D:\\blender.exe --background --factory-startup --python scripts/room/room.py -- <stage> [options]

Stages (run in order; each saves/loads scripts/room/cache/room.blend):
    build     shell + Poly Haven furniture + practicals + light groups, lightmap UVs
    preview   quick Cycles renders of both light groups (look-dev)
    bake      DARK and PARTY irradiance lightmaps -> cache/lm-*.exr + encoded PNGs + cache/bake.json
    export    cache/room-raw.glb (UV0 textures + UV1 lightmap UVs), for scripts/room/optimize.mjs
    poster    Cycles stills (dark / lit) -> cache/poster-*.png
Options: --samples N, --size N (bake resolution), --res WxH (preview/poster).

Coordinates: layout.json is in three.js space (y up, camera enters from +z);
B(x, y, z) = (x, -z, y) converts to Blender (z up). The glTF exporter's +Y-up
conversion maps it back exactly.

Light groups (what the runtime blends with uniforms):
    DARK   city window (emissive skyline + night sky), corridor spill through
           the open front door, the switch locator LED
    PARTY  4 ceiling downlights, pendant over the table, floor lamp, fairy
           lights (curtain on the window + swag on the back wall)
The candle and all party props are real-time in the browser, not baked.
"""
import bpy, bmesh, json, math, os, sys
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, 'cache')
BLEND = os.path.join(CACHE, 'room.blend')
L = json.load(open(os.path.join(HERE, 'layout.json')))
R = L['room']
X, Z, H = R['halfX'], R['halfZ'], R['height']
WIN, DOOR, PIER = L['window'], L['door'], L['pier']
WALL_T = 0.15

argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
STAGE = argv[0] if argv else 'build'
def opt(name, default):
    if name in argv:
        return argv[argv.index(name) + 1]
    return default


def B(x, y, z):
    return Vector((x, -z, y))


# --------------------------------------------------------------------------
# Scene / render setup
# --------------------------------------------------------------------------

def setup_cycles(samples=128):
    sc = bpy.context.scene
    sc.render.engine = 'CYCLES'
    prefs = bpy.context.preferences.addons['cycles'].preferences
    for t in ('OPTIX', 'CUDA'):
        try:
            prefs.compute_device_type = t
            prefs.get_devices()
            ok = False
            for d in prefs.devices:
                d.use = d.type == t
                ok = ok or d.use
            if ok:
                break
        except Exception:
            continue
    sc.cycles.device = 'GPU'
    sc.cycles.samples = samples
    sc.cycles.use_adaptive_sampling = True
    sc.cycles.max_bounces = 8
    sc.cycles.diffuse_bounces = 5
    sc.cycles.glossy_bounces = 3
    sc.cycles.transmission_bounces = 4
    sc.cycles.sample_clamp_indirect = 8
    sc.cycles.caustics_reflective = False
    sc.cycles.caustics_refractive = False
    sc.view_settings.view_transform = 'AgX'
    sc.view_settings.look = 'None'
    sc.render.film_transparent = False


def new_mat(name, color=(0.8, 0.8, 0.8), rough=0.5, metal=0.0, emit=None, emit_strength=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    p = nt.nodes.get('Principled BSDF')
    p.inputs['Base Color'].default_value = (*color, 1)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    if emit is not None:
        p.inputs['Emission Color'].default_value = (*emit, 1)
        p.inputs['Emission Strength'].default_value = emit_strength
    return m


def image_node(nt, path, non_color=False):
    img = bpy.data.images.load(path, check_existing=True)
    if non_color:
        img.colorspace_settings.name = 'Non-Color'
    n = nt.nodes.new('ShaderNodeTexImage')
    n.image = img
    return n


def textured_mat(name, diff, nor, arm, rough_mul=1.0, normal_strength=1.0):
    """Principled with diffuse / normal / ARM in the glTF-exportable layout."""
    m = new_mat(name)
    nt = m.node_tree
    p = nt.nodes.get('Principled BSDF')
    d = image_node(nt, diff)
    nt.links.new(d.outputs['Color'], p.inputs['Base Color'])
    if arm:
        a = image_node(nt, arm, True)
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(a.outputs['Color'], sep.inputs['Color'])
        nt.links.new(sep.outputs['Green'], p.inputs['Roughness'])
        nt.links.new(sep.outputs['Blue'], p.inputs['Metallic'])
    if nor:
        n = image_node(nt, nor, True)
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.inputs['Strength'].default_value = normal_strength
        nt.links.new(n.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs['Normal'], p.inputs['Normal'])
    return m


def link(obj, coll):
    for c in obj.users_collection:
        c.objects.unlink(obj)
    coll.objects.link(obj)


def collection(name):
    c = bpy.data.collections.get(name)
    if not c:
        c = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(c)
    return c


# --------------------------------------------------------------------------
# Geometry helpers (all input in three.js coordinates)
# --------------------------------------------------------------------------

def mesh_from(name, verts, faces, mat, coll, uv_tile=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in verts], [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    coll.objects.link(ob)
    me.materials.append(mat)
    world_uv(ob, uv_tile or 1.0)
    return ob


def world_uv(ob, tile):
    """UVMap by planar projection along each face's dominant axis (metres / tile)."""
    me = ob.data
    if not me.uv_layers:
        me.uv_layers.new(name='UVMap')
    bm = bmesh.new()
    bm.from_mesh(me)
    uv = bm.loops.layers.uv.active
    for f in bm.faces:
        n = f.normal
        ax = max(range(3), key=lambda i: abs(n[i]))
        for lp in f.loops:
            co = ob.matrix_world @ lp.vert.co
            if ax == 0:
                u, v = co.y * (1 if n.x < 0 else -1), co.z
            elif ax == 1:
                u, v = co.x * (1 if n.y > 0 else -1), co.z
            else:
                u, v = co.x, co.y * (1 if n.z > 0 else -1)
            lp[uv].uv = (u / tile, v / tile)
    bm.to_mesh(me)
    bm.free()


def quad(name, a, b, c, d, mat, coll, tile=1.0):
    """Quad from four three.js corners, counter-clockwise seen from the front."""
    return mesh_from(name, [B(*a), B(*b), B(*c), B(*d)], [(0, 1, 2, 3)], mat, coll, tile)


def box(name, mn, mx, mat, coll, tile=1.0, drop=()):
    """Axis-aligned box in three.js coordinates. drop: faces to omit
    ('-x','+x','-y','+y','-z','+z' in three.js axes)."""
    x0, y0, z0 = mn
    x1, y1, z1 = mx
    faces = {
        '-x': [(x0, y0, z1), (x0, y1, z1), (x0, y1, z0), (x0, y0, z0)],
        '+x': [(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)],
        '-y': [(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)],
        '+y': [(x0, y1, z1), (x1, y1, z1), (x1, y1, z0), (x0, y1, z0)],
        '-z': [(x1, y0, z0), (x0, y0, z0), (x0, y1, z0), (x1, y1, z0)],
        '+z': [(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)],
    }
    verts, fl = [], []
    for k, f in faces.items():
        if k in drop:
            continue
        i = len(verts)
        verts += [B(*p) for p in f]
        fl.append((i, i + 1, i + 2, i + 3))
    return mesh_from(name, verts, fl, mat, coll, tile)


def cylinder(name, center, radius, y0, y1, mat, coll, seg=48, caps=(True, True), inside=False, tile=1.0):
    cx, cz = center
    verts, faces = [], []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        verts.append(B(cx + math.cos(a) * radius, y0, cz + math.sin(a) * radius))
        verts.append(B(cx + math.cos(a) * radius, y1, cz + math.sin(a) * radius))
    for i in range(seg):
        j = (i + 1) % seg
        f = (2 * i, 2 * j, 2 * j + 1, 2 * i + 1)
        faces.append(f if inside else f[::-1])
    if caps[1]:
        faces.append(tuple(2 * i + 1 for i in range(seg)))
    if caps[0]:
        faces.append(tuple(2 * i for i in reversed(range(seg))))
    ob = mesh_from(name, verts, faces, mat, coll, tile)
    # Normals outward (recalc), then flip for inside surfaces.
    bm = bmesh.new(); bm.from_mesh(ob.data)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if inside:
        bmesh.ops.reverse_faces(bm, faces=bm.faces)
    bm.to_mesh(ob.data); bm.free()
    return ob


def smooth(ob, angle=40):
    for p in ob.data.polygons:
        p.use_smooth = True
    try:
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.shade_auto_smooth(angle=math.radians(angle))
    except Exception:
        pass


# --------------------------------------------------------------------------
# Build
# --------------------------------------------------------------------------

def tinted_plaster(name='plaster_warm', base=(0.80, 0.785, 0.75)):
    """Poly Haven plaster, re-tinted (linear base colour +- its own variation)."""
    import numpy as np
    src = os.path.join(CACHE, 'plastered_wall_04', 'plastered_wall_04_diff_1k.jpg')
    out = os.path.join(CACHE, f'{name}.png')
    if os.path.exists(out):
        return out
    img = bpy.data.images.load(src)
    px = np.array(img.pixels[:], dtype=np.float32).reshape(-1, 4)
    lum = px[:, :3] @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
    mean = lum.mean()
    # Keep the plaster's variation (+-), put it on a warm off-white base.
    base = np.array(base, dtype=np.float32)
    var = (lum - mean)[:, None] * 0.55
    px[:, :3] = np.clip(base + var, 0, 1)
    img.pixels[:] = px.ravel()
    img.filepath_raw = out
    img.file_format = 'PNG'
    img.save()
    bpy.data.images.remove(img)
    return out


def import_asset(aid):
    man = json.load(open(os.path.join(CACHE, 'manifest.json')))
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(CACHE, man['assets'][aid]['gltf']))
    objs = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in objs if o.type == 'MESH']
    # Bake parents into the meshes, drop the empties.
    for o in meshes:
        mw = o.matrix_world.copy()
        o.parent = None
        o.matrix_world = mw
    for o in objs:
        if o.type != 'MESH':
            bpy.data.objects.remove(o)
    return meshes


def place(meshes, loc, yaw_deg=0.0, scale=1.0, coll=None):
    """Transform imported meshes: scale, rotate about Blender Z, move (three.js loc
    of the footprint centre at floor level y)."""
    m = Matrix.Translation(B(*loc)) @ Matrix.Rotation(math.radians(yaw_deg), 4, 'Z') @ Matrix.Scale(scale, 4)
    for o in meshes:
        o.matrix_world = m @ o.matrix_world
        if coll:
            link(o, coll)
    bpy.ops.object.select_all(action='DESELECT')
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def bbox(objs):
    mn = Vector((1e9,) * 3)
    mx = -mn
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            mn = Vector(map(min, mn, w))
            mx = Vector(map(max, mx, w))
    return mn, mx


def split_by_material(ob):
    bpy.ops.object.select_all(action='DESELECT')
    ob.select_set(True)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.mesh.separate(type='MATERIAL')
    bpy.ops.object.mode_set(mode='OBJECT')
    return [o for o in bpy.context.selected_objects]


def light(name, kind, loc, power, color, coll, size=0.05, rot=None, spot=None):
    ld = bpy.data.lights.new(name, kind)
    ld.energy = power
    ld.color = color
    if kind in ('POINT', 'SPOT'):
        ld.shadow_soft_size = size
    if kind == 'AREA':
        ld.size = size
    if spot:
        ld.spot_size = math.radians(spot[0])
        ld.spot_blend = spot[1]
    ob = bpy.data.objects.new(name, ld)
    ob.location = loc
    if rot:
        ob.rotation_euler = rot
    coll.objects.link(ob)
    return ob


def kelvin(k):
    """Approximate blackbody colour (linear RGB), 1000-10000 K."""
    t = k / 100.0
    r = 255 if t <= 66 else 329.698727446 * ((t - 60) ** -0.1332047592)
    g = 99.4708025861 * math.log(t) - 161.1195681661 if t <= 66 else 288.1221695283 * ((t - 60) ** -0.0755148492)
    b = 255 if t >= 66 else (0 if t <= 19 else 138.5177312231 * math.log(t - 10) - 305.0447927307)
    srgb = [max(0, min(255, c)) / 255 for c in (r, g, b)]
    return tuple(((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92 for c in srgb)


def stage_build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    setup_cycles()
    sc = bpy.context.scene
    sc.unit_settings.system = 'METRIC'
    EXP = collection('export')        # baked + exported
    EXPX = collection('export_nobake')  # exported, not lightmapped (emissive/glass/photo)
    NOEXP = collection('bake_only')    # lighting helpers, city, corridor
    LDARK = collection('lights_dark')
    LPARTY = collection('lights_party')

    # --- materials
    pq = os.path.join(CACHE, 'herringbone_parquet')
    floor = textured_mat('floor_parquet', os.path.join(pq, 'herringbone_parquet_diff_1k.jpg'),
                         os.path.join(pq, 'herringbone_parquet_nor_gl_1k.jpg'), os.path.join(pq, 'herringbone_parquet_arm_1k.jpg'))
    pl = os.path.join(CACHE, 'plastered_wall_04')
    wall = textured_mat('wall_plaster', tinted_plaster(), os.path.join(pl, 'plastered_wall_04_nor_gl_1k.jpg'), None, normal_strength=0.35)
    wall.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.92
    # Feature wall behind the foil letters (greige): the letters pop when
    # lit and do not read as silhouettes against a pale wall in the dark.
    accent = textured_mat('wall_accent', tinted_plaster('plaster_accent', (0.47, 0.445, 0.42)), os.path.join(pl, 'plastered_wall_04_nor_gl_1k.jpg'), None, normal_strength=0.35)
    accent.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.9
    ceiling = new_mat('ceiling_paint', (0.88, 0.87, 0.84), 0.95)
    trim = new_mat('trim_paint', (0.86, 0.84, 0.8), 0.45)
    frame_m = new_mat('window_frame', (0.05, 0.05, 0.055), 0.35, 0.8)
    curtain = new_mat('curtain_linen', (0.78, 0.72, 0.64), 0.95)
    rug = new_mat('rug_wool', (0.42, 0.36, 0.3), 1.0)
    metal = new_mat('lamp_metal', (0.02, 0.02, 0.02), 0.4, 0.9)
    glass = new_mat('glass_window', (0.9, 0.93, 0.95), 0.03)
    gp = glass.node_tree.nodes['Principled BSDF']
    gp.inputs['Transmission Weight'].default_value = 1.0
    glass.blend_method = 'BLEND' if hasattr(glass, 'blend_method') else None
    warm = kelvin(4000)  # ceiling downlights: Thai-condo neutral white
    emit_down = new_mat('emit_downlight', (1, 1, 1), 0.5, emit=warm, emit_strength=12.0)
    emit_shade = new_mat('emit_lampshade', (0.9, 0.82, 0.68), 0.9, emit=kelvin(2700), emit_strength=3.0)
    hall = new_mat('hall_paint', (0.7, 0.65, 0.58), 0.9)

    # --- shell (inner surfaces only; y up three.js coords)
    quad('floor', (-X, 0, Z), (X, 0, Z), (X, 0, -Z), (-X, 0, -Z), floor, EXP, tile=3.4)
    quad('ceiling', (-X, H, -Z), (X, H, -Z), (X, H, Z), (-X, H, Z), ceiling, EXP, tile=2.0)
    # back wall (z = -Z, faces +z) with the balcony window / sliding door
    wx0, wx1, wy0, wy1 = WIN['x0'], WIN['x1'], WIN['y0'], WIN['y1']
    def bq(name, x0, x1, y0, y1, z=-Z, mat=None):
        quad(name, (x0, y0, z), (x1, y0, z), (x1, y1, z), (x0, y1, z), mat or wall, EXP, tile=3.2)
    bq('wall_back_a', -X, wx0, 0, H, mat=accent)
    bq('wall_back_b', wx1, X, 0, H)
    bq('wall_back_top', wx0, wx1, wy1, H)
    bq('wall_back_low', wx0, wx1, 0, wy0)
    quad('wall_left', (-X, 0, Z), (-X, 0, -Z), (-X, H, -Z), (-X, H, Z), wall, EXP, tile=3.2)
    # front wall (z = +Z, faces -z) with the door opening
    dx0, dx1, dy1 = DOOR['x0'], DOOR['x1'], DOOR['y1']
    quad('wall_front_a', (dx0, 0, Z), (-X, 0, Z), (-X, H, Z), (dx0, H, Z), wall, EXP, tile=3.2)
    quad('wall_front_b', (X, 0, Z), (dx1, 0, Z), (dx1, H, Z), (X, H, Z), wall, EXP, tile=3.2)
    quad('wall_front_c', (dx1, dy1, Z), (dx0, dy1, Z), (dx0, H, Z), (dx1, H, Z), wall, EXP, tile=3.2)
    # right wall (x = +X, faces -x) with the column the switch is on
    px0, pz0, pz1 = PIER['x0'], PIER['z0'], PIER['z1']
    def rq(name, z0, z1, y0, y1, x=X):
        quad(name, (x, y0, z0), (x, y0, z1), (x, y1, z1), (x, y1, z0), wall, EXP, tile=3.2)
    rq('wall_right_a', -Z, pz0, 0, H)
    rq('wall_right_c', pz1, Z, 0, H)
    quad('pier_front', (px0, 0, pz1), (X, 0, pz1), (X, H, pz1), (px0, H, pz1), wall, EXP, tile=3.2)
    quad('pier_back', (X, 0, pz0), (px0, 0, pz0), (px0, H, pz0), (X, H, pz0), wall, EXP, tile=3.2)
    rq('pier_side', pz0, pz1, 0, H, x=px0)
    # window reveals (wall thickness, towards -z)
    T = WALL_T
    zo = -Z - T
    quad('win_sill', (wx0, wy0, zo), (wx1, wy0, zo), (wx1, wy0, -Z), (wx0, wy0, -Z), trim, EXP)
    quad('win_head', (wx0, wy1, -Z), (wx1, wy1, -Z), (wx1, wy1, zo), (wx0, wy1, zo), trim, EXP)
    quad('win_side0', (wx0, wy0, zo), (wx0, wy0, -Z), (wx0, wy1, -Z), (wx0, wy1, zo), wall, EXP)
    quad('win_side1', (wx1, wy0, -Z), (wx1, wy0, zo), (wx1, wy1, zo), (wx1, wy1, -Z), wall, EXP)
    # door reveals
    quad('door_jamb0', (dx0, 0, Z + T), (dx0, 0, Z), (dx0, dy1, Z), (dx0, dy1, Z + T), trim, EXP)
    quad('door_jamb1', (dx1, 0, Z), (dx1, 0, Z + T), (dx1, dy1, Z + T), (dx1, dy1, Z), trim, EXP)
    quad('door_head', (dx0, dy1, Z), (dx1, dy1, Z), (dx1, dy1, Z + T), (dx0, dy1, Z + T), trim, EXP)
    # skirting (front face + top), along each wall segment
    sk_h, sk_t = 0.085, 0.014
    def skirt(name, a, b, inward):
        ax, az = a
        bx, bz = b
        ix, iz = inward
        o = (ax + ix * sk_t, az + iz * sk_t)
        p = (bx + ix * sk_t, bz + iz * sk_t)
        quad(name + '_f', (o[0], 0, o[1]), (p[0], 0, p[1]), (p[0], sk_h, p[1]), (o[0], sk_h, o[1]), trim, EXP)
        quad(name + '_t', (o[0], sk_h, o[1]), (p[0], sk_h, p[1]), (bx, sk_h, bz), (ax, sk_h, az), trim, EXP)
    skirt('sk_back', (-X, -Z), (wx0, -Z), (0, 1))
    skirt('sk_back_b', (wx1, -Z), (X, -Z), (0, 1))
    skirt('sk_left', (-X, Z), (-X, -Z), (1, 0))
    skirt('sk_front_a', (dx0, Z), (-X, Z), (0, -1))
    skirt('sk_right_a', (X, -Z), (X, pz0), (-1, 0))
    skirt('sk_right_c', (X, pz1), (X, dx1 * 0 + Z), (-1, 0))

    # window: sliding door frame + glass (mid-reveal)
    fz = -Z - 0.07
    fw = 0.045
    def fbox(name, x0, x1, y0, y1):
        box(name, (x0, y0, fz - 0.025), (x1, y1, fz + 0.025), frame_m, EXP)
    fbox('wf_top', wx0, wx1, wy1 - fw, wy1)
    fbox('wf_bot', wx0, wx1, wy0, wy0 + fw)
    fbox('wf_l', wx0, wx0 + fw, wy0, wy1)
    fbox('wf_r', wx1 - fw, wx1, wy0, wy1)
    xm = (wx0 + wx1) / 2
    fbox('wf_mid', xm - fw / 2, xm + fw / 2, wy0, wy1)
    fbox('wf_rail', wx0, wx1, 1.05, 1.05 + 0.03)
    g = quad('GLASS_window', (wx0, wy0, fz), (wx1, wy0, fz), (wx1, wy1, fz), (wx0, wy1, fz), glass, EXPX)
    g.visible_diffuse = False
    g.visible_shadow = False
    g.visible_volume_scatter = False

    # curtains (sheer, gathered at both sides of the window) + rail
    def curtain_mesh(name, x0, x1, z):
        nx, ny = 36, 8
        verts, faces = [], []
        for j in range(ny + 1):
            y = 0.03 + (2.52 - 0.03) * j / ny
            for i in range(nx + 1):
                t = i / nx
                x = x0 + (x1 - x0) * t
                verts.append(B(x, y, z + 0.035 * math.sin(t * math.pi * 9) ** 2 + 0.01 * j / ny))
        for j in range(ny):
            for i in range(nx):
                a = j * (nx + 1) + i
                faces.append((a, a + nx + 1, a + nx + 2, a + 1))
        ob = mesh_from(name, verts, faces, curtain, EXP)
        smooth(ob, 80)
        return ob
    curtain_mesh('curtain_a', wx0 - 0.14, wx0 + 0.28, -Z + 0.1)
    curtain_mesh('curtain_b', wx1 - 0.28, wx1 + 0.12, -Z + 0.1)
    box('curtain_rail', (wx0 - 0.2, 2.53, -Z + 0.1), (min(wx1 + 0.18, X), 2.56, -Z + 0.14), metal, EXP)

    # rug under the table
    tb = L['table']
    cylinder('rug', (tb['x'], tb['z']), 0.95, 0.0, 0.009, rug, EXP, seg=64, caps=(False, True), tile=1.0)

    # --- furniture (Poly Haven, CC0)
    table = import_asset('round_wooden_table_01')
    mn, mx = bbox(table)
    place(table, (tb['x'], 0, tb['z']), 0, tb['height'] / (mx.z - mn.z), EXP)
    shelves = import_asset('wooden_display_shelves_01')
    drawers = [o for o in shelves if 'drawer' in o.name]
    front_sign = 1 if sum((o.matrix_world @ Vector(o.bound_box[0])).x + (o.matrix_world @ Vector(o.bound_box[6])).x for o in drawers) >= 0 else -1
    place(shelves, (L['shelves']['x'], 0, L['shelves']['z']), -90 if front_sign > 0 else 90, 1.0, EXP)
    side = import_asset('side_table_01')
    place(side, (L['sideTable']['x'], 0, L['sideTable']['z']), 15, 1.0, EXP)
    smn, smx = bbox(side)
    vase = import_asset('ceramic_vase_01')
    for o in vase:
        dec = o.modifiers.new('dec', 'DECIMATE')
        dec.ratio = 0.3
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.modifier_apply(modifier='dec')
    place(vase, (L['sideTable']['x'] + 0.08, smx.z, L['sideTable']['z'] - 0.05), 0, 0.9, EXP)
    lamp = import_asset('modern_ceiling_lamp_01')
    lmn, lmx = bbox(lamp)
    place(lamp, (tb['x'], H - lmx.z, tb['z']), 0, 1.0, EXP)
    frame = import_asset('standing_picture_frame_01')
    fr = L['frame']
    place(frame, (fr['x'], tb['height'], fr['z']), math.degrees(fr['yaw']) - 90, 1.25, EXP)

    # Pieces that must not be lightmapped: glass, emissive globe, the photo.
    for ob in list(lamp) + list(frame):
        parts = split_by_material(ob) if len(ob.data.materials) > 1 else [ob]
        for p in parts:
            mname = p.data.materials[0].name.lower() if p.data.materials else ''
            if 'glass' in mname:
                p.data.materials[0].name = 'glass_' + p.data.materials[0].name
                link(p, EXPX)
                p.visible_shadow = False
                p.visible_diffuse = False
            elif 'globe' in mname:
                gm = p.data.materials[0]
                gm.name = 'emit_globe'
                pb = gm.node_tree.nodes.get('Principled BSDF')
                if pb:
                    pb.inputs['Emission Color'].default_value = (*kelvin(2700), 1)
                    pb.inputs['Emission Strength'].default_value = 4.0
                link(p, EXPX)
            elif 'artwork' in mname:
                p.name = 'PHOTO'
                link(p, EXPX)
    gmn, gmx = bbox([o for o in bpy.data.objects if o.data and hasattr(o.data, 'materials') and o.data.materials and o.data.materials[0].name == 'emit_globe'] or lamp)
    pendant_c = (gmn + gmx) / 2

    # floor lamp (procedural): base, pole, drum shade
    fl = L['floorLamp']
    cylinder('flamp_base', (fl['x'], fl['z']), 0.16, 0.0, 0.025, metal, EXP, seg=32)
    cylinder('flamp_pole', (fl['x'], fl['z']), 0.012, 0.025, 1.38, metal, EXP, seg=12, caps=(False, False))
    shade = cylinder('EMIT_flamp_shade', (fl['x'], fl['z']), 0.21, 1.3, 1.62, emit_shade, EXPX, seg=48, caps=(False, False))
    shade.data.materials[0].use_backface_culling = False

    # ceiling downlights (flush discs + trim)
    for i, (dxp, dzp) in enumerate(L['downlights']):
        cylinder(f'EMIT_down_{i}', (dxp, dzp), 0.045, H - 0.003, H - 0.002, emit_down, EXPX, seg=24, caps=(True, False))
        cylinder(f'down_trim_{i}', (dxp, dzp), 0.058, H - 0.004, H - 0.001, trim, EXP, seg=24, caps=(True, False))

    # --- Thai-condo cues (procedural, no licences): modern fabric sofa,
    # TV console + flat TV, split AC unit; Poly Haven wall clock + succulent.
    fabric = new_mat('sofa_fabric', (0.30, 0.31, 0.32), 1.0)
    legs_m = new_mat('sofa_legs', (0.08, 0.06, 0.05), 0.5, 0.2)
    plastic = new_mat('ac_plastic', (0.86, 0.86, 0.85), 0.35)
    tv_black = new_mat('tv_panel', (0.01, 0.01, 0.012), 0.08)
    tv_bezel = new_mat('tv_bezel', (0.02, 0.02, 0.022), 0.4, 0.5)
    console_m = new_mat('console_wood', (0.30, 0.19, 0.11), 0.45)
    console_top = new_mat('console_top', (0.22, 0.14, 0.08), 0.35)

    def rbox(name, center, size, mat, coll=EXP, bevel=0.02, segs=3):
        cx, cy, cz = center
        sx, sy, sz = size
        ob = box(name, (cx - sx / 2, cy - sy / 2, cz - sz / 2), (cx + sx / 2, cy + sy / 2, cz + sz / 2), mat, coll)
        bm = bmesh.new(); bm.from_mesh(ob.data)
        bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
        bm.to_mesh(ob.data); bm.free()
        if bevel > 0:
            mod = ob.modifiers.new('bevel', 'BEVEL')
            mod.width = bevel
            mod.segments = segs
            mod.limit_method = 'NONE'
            bpy.context.view_layer.objects.active = ob
            bpy.ops.object.modifier_apply(modifier='bevel')
        smooth(ob, 35)
        world_uv(ob, 1.0)
        return ob

    # Sofa against the left wall, facing +x (three.js), 2.0 m three-seater.
    sx, sz = L['sofa']['x'], L['sofa']['z']
    dep, wid = 0.9, 2.0
    x0 = -X + 0.03
    rbox('sofa_base', (x0 + dep / 2, 0.26, sz), (dep, 0.22, wid), fabric, bevel=0.03)
    rbox('sofa_back', (x0 + 0.12, 0.6, sz), (0.2, 0.5, wid - 0.02), fabric, bevel=0.06, segs=4)
    for s in (-1, 1):
        rbox(f'sofa_arm_{s}', (x0 + dep / 2, 0.43, sz + s * (wid / 2 - 0.09)), (dep, 0.34, 0.18), fabric, bevel=0.06, segs=4)
    for i in range(3):
        zc = sz - (wid - 0.36) / 2 + (wid - 0.36) / 3 * (i + 0.5)
        rbox(f'sofa_seat_{i}', (x0 + 0.22 + 0.33, 0.43, zc), (0.62, 0.13, (wid - 0.36) / 3 - 0.01), fabric, bevel=0.05, segs=4)
        rbox(f'sofa_cush_{i}', (x0 + 0.3, 0.68, zc), (0.16, 0.36, (wid - 0.36) / 3 - 0.03), fabric, bevel=0.06, segs=4)
    for lx in (x0 + 0.08, x0 + dep - 0.08):
        for lz in (sz - wid / 2 + 0.08, sz + wid / 2 - 0.08):
            cylinder(f'sofa_leg_{lx:.2f}_{lz:.2f}', (lx, lz), 0.018, 0.0, 0.15, legs_m, EXP, seg=10)

    # TV console + flat TV on the right wall (between the column and the door).
    tz0, tz1 = PIER['z1'] + 0.45, PIER['z1'] + 1.85
    tzc = (tz0 + tz1) / 2
    rbox('tv_console', (X - 0.21, 0.24, tzc), (0.4, 0.4, tz1 - tz0), console_m, bevel=0.01, segs=2)
    rbox('tv_console_top', (X - 0.21, 0.455, tzc), (0.42, 0.03, tz1 - tz0 + 0.02), console_top, bevel=0.006, segs=2)
    rbox('tv_bezel', (X - 0.035, 1.1, tzc), (0.04, 0.57, 0.98), tv_bezel, bevel=0.008, segs=2)
    quad('tv_screen', (X - 0.056, 0.83, tzc + 0.475), (X - 0.056, 0.83, tzc - 0.475), (X - 0.056, 1.37, tzc - 0.475), (X - 0.056, 1.37, tzc + 0.475), tv_black, EXP)

    # Split AC unit, high on the right wall near the balcony corner.
    rbox('ac_unit', (X - 0.12, 2.3, -1.65), (0.22, 0.28, 0.86), plastic, bevel=0.04, segs=4)
    quad('ac_vent', (X - 0.2305, 2.19, -1.25), (X - 0.2305, 2.19, -2.05), (X - 0.2305, 2.22, -2.05), (X - 0.2305, 2.22, -1.25), tv_black, EXP)
    ld = light('dark_ac_led', 'POINT', B(X - 0.235, 2.25, -1.3), 0.01, (0.3, 0.6, 1.0), LDARK, size=0.004)

    clock = import_asset('wall_clock')
    cmn, cmx = bbox(clock)
    # Face towards -x (into the room) on the right wall above the TV.
    place(clock, (X - 0.03, 1.95, tzc), -90 if (cmx.y - cmn.y) < (cmx.x - cmn.x) else 0, 1.0, EXP)
    plant = import_asset('potted_plant_04')
    place(plant, (X - 0.3, 0.47, tz1 - 0.2), 0, 1.0, EXP)

    # --- bake-only: city, sky, corridor
    city_m = bpy.data.materials.new('city_emit')
    city_m.use_nodes = True
    nt = city_m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    em = nt.nodes.new('ShaderNodeEmission')
    im = image_node(nt, os.path.join(CACHE, 'city.png'))
    nt.links.new(im.outputs['Color'], em.inputs['Color'])
    em.inputs['Strength'].default_value = 4.0
    nt.links.new(em.outputs['Emission'], out.inputs['Surface'])
    # Panorama arc around the room (same formula as src/room/shell.js
    # cityArc): rays leaving the window at any angle land on the skyline.
    ca = L['city']
    verts, faces, uvs = [], [], []
    n = 48
    for i in range(n + 1):
        t = i / n
        th = math.radians(ca['theta0'] + (ca['theta1'] - ca['theta0']) * t)
        x = ca['cx'] + ca['radius'] * math.cos(th)
        z = ca['cz'] + ca['radius'] * math.sin(th)
        verts += [B(x, ca['y0'], z), B(x, ca['y1'], z)]
        uvs += [(t * ca['repeat'], 0), (t * ca['repeat'], 1)]
    for i in range(n):
        faces.append((2 * i, 2 * i + 2, 2 * i + 3, 2 * i + 1))
    city = mesh_from('city', verts, faces, city_m, NOEXP)
    uvl = city.data.uv_layers.active.data
    for f in city.data.polygons:
        for li in f.loop_indices:
            uvl[li].uv = uvs[city.data.loops[li].vertex_index]
    link(city, LDARK)
    # night sky world (reaches the room only through the window)
    world = bpy.data.worlds.new('night')
    sc.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes['Background']
    bg.inputs['Color'].default_value = (0.02, 0.03, 0.075, 1)
    bg.inputs['Strength'].default_value = 1.0
    # corridor behind the open front door
    cz0, cz1 = Z + T, Z + 2.2
    box('hall', (dx0 - 0.5, 0, cz0), (X, 2.45, cz1), hall, NOEXP, drop=('-z',))
    hb = bpy.data.objects['hall']
    bm = bmesh.new(); bm.from_mesh(hb.data); bmesh.ops.reverse_faces(bm, faces=bm.faces); bm.to_mesh(hb.data); bm.free()
    # Corridor spill: a door-sized area light in the opening, facing in
    # (direct light bakes clean; bounced light from a lit hallway was noise).
    # The front door is closed behind us: only a thin gap of hallway light
    # on the floor (behind the camera). The window is the one real source:
    # cool ~8000 K spill through the glass, on top of the city emission.
    gap = light('dark_door_gap', 'AREA', B((dx0 + dx1) / 2, 0.006, Z - 0.01), 0.35, kelvin(4000), LDARK, rot=(math.pi / 2, 0, 0))
    gap.data.shape = 'RECTANGLE'
    gap.data.size = dx1 - dx0 - 0.1
    gap.data.size_y = 0.01
    # 1.2 m outside and larger than the opening, so it reads like sky/city
    # glow (near-parallel) instead of a lamp that over-lights the sheers and
    # the ceiling next to the glass.
    win = light('dark_window', 'AREA', B((wx0 + wx1) / 2, (wy0 + wy1) / 2 - 0.2, -Z - 1.2), 26, (0.5, 0.66, 1.0), LDARK, rot=(-math.pi / 2, 0, 0))
    win.data.shape = 'RECTANGLE'
    win.data.size = (wx1 - wx0) * 1.6
    win.data.size_y = (wy1 - wy0) * 1.3
    # A light, not a white card in the window: the camera and reflections
    # see the city behind it.
    win.visible_camera = False
    win.visible_glossy = False
    win.visible_transmission = False
    sw = L['switch']
    light('dark_switch', 'POINT', B(sw['x'], sw['y'], sw['z'] + 0.02), 0.12, kelvin(2200), LDARK, size=0.01)

    # --- party lights
    for i, (dxp, dzp) in enumerate(L['downlights']):
        light(f'party_down_{i}', 'SPOT', B(dxp, H - 0.01, dzp), 32, warm, LPARTY, size=0.04, spot=(110, 0.7))
    light('party_pendant', 'POINT', pendant_c, 45, kelvin(2700), LPARTY, size=0.07)
    light('party_floorlamp', 'POINT', B(fl['x'], 1.47, fl['z']), 30, kelvin(2700), LPARTY, size=0.08)
    # fairy lights: thin emissive strands (the runtime draws the actual bulbs)
    fairy_m = bpy.data.materials.new('fairy_emit')
    fairy_m.use_nodes = True
    fnt = fairy_m.node_tree
    for n in list(fnt.nodes):
        fnt.nodes.remove(n)
    fo = fnt.nodes.new('ShaderNodeOutputMaterial')
    fe = fnt.nodes.new('ShaderNodeEmission')
    fe.inputs['Color'].default_value = (*kelvin(2400), 1)
    fe.inputs['Strength'].default_value = 60.0
    fnt.links.new(fe.outputs['Emission'], fo.inputs['Surface'])
    fz_ = L['fairy']['curtainZ']
    for i in range(11):
        xc = wx0 + 0.34 + (wx1 - wx0 - 0.68) * i / 10
        cylinder_y = cylinder(f'fairy_curtain_{i}', (xc, fz_), 0.004, wy1 - 1.2, wy1 - 0.02, fairy_m, LPARTY, seg=6)
        cylinder_y.visible_camera = False
        cylinder_y.visible_glossy = False
    sw_ = L['fairy']['swag']
    pts = []
    for i in range(17):
        t = i / 16
        x = sw_['x0'] + (sw_['x1'] - sw_['x0']) * t
        y = sw_['y'] - sw_['sag'] * 4 * t * (1 - t)
        pts.append((x, y))
    for i in range(16):
        (xa, ya), (xb, yb) = pts[i], pts[i + 1]
        cyl = bpy.data.objects.new(f'fairy_swag_{i}', None)
        # little emissive sphere per segment midpoint (cheap stand-in for bulbs)
        bpy.ops.mesh.primitive_uv_sphere_add(radius=0.012, location=B((xa + xb) / 2, (ya + yb) / 2, sw_['z'] + 0.02), segments=8, ring_count=6)
        s = bpy.context.active_object
        s.name = f'fairy_swag_{i}'
        s.data.materials.append(fairy_m)
        s.visible_camera = False
        s.visible_glossy = False
        link(s, LPARTY)

    # --- lightmap UVs: join everything baked into one object, second UV layer
    exp_objs = [o for o in EXP.objects if o.type == 'MESH']
    for o in exp_objs:
        me = o.data
        if not me.uv_layers:
            me.uv_layers.new(name='UVMap')
        me.uv_layers[0].name = 'UVMap'
        while len(me.uv_layers) > 1:
            me.uv_layers.remove(me.uv_layers[1])
    bpy.ops.object.select_all(action='DESELECT')
    for o in exp_objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = exp_objs[0]
    bpy.ops.object.join()
    room = bpy.context.active_object
    room.name = 'ROOM'
    lm = room.data.uv_layers.new(name='LM')
    room.data.uv_layers.active = lm
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.select_all(action='SELECT')
    bpy.ops.uv.smart_project(angle_limit=math.radians(60), island_margin=0.002, area_weight=0.0, correct_aspect=True, scale_to_bounds=False)
    bpy.ops.uv.pack_islands(rotate=True, margin=0.004)
    bpy.ops.object.mode_set(mode='OBJECT')
    room.data.uv_layers.active = room.data.uv_layers['UVMap']
    room.data.uv_layers['UVMap'].active_render = True

    info = {
        'pendant': [pendant_c.x, pendant_c.z, -pendant_c.y],
        'tableTopY': tb['height'],
        'tris': sum(len(p.vertices) - 2 for p in room.data.polygons),
        'materials': [m.name for m in room.data.materials],
    }
    json.dump(info, open(os.path.join(CACHE, 'build.json'), 'w'), indent=1)
    print('BUILD', json.dumps(info))
    bpy.ops.wm.save_as_mainfile(filepath=BLEND)


# --------------------------------------------------------------------------
# Light-group switching
# --------------------------------------------------------------------------

EMIT_PARTY = {'emit_downlight': 12.0, 'emit_lampshade': 3.0, 'emit_globe': 4.0}


def set_state(state):
    """'dark' | 'party' | 'lit' (both) | 'none'."""
    dark_on = state in ('dark', 'lit')
    party_on = state in ('party', 'lit')
    for o in bpy.data.collections['lights_dark'].objects:
        o.hide_render = not dark_on
    for o in bpy.data.collections['lights_party'].objects:
        o.hide_render = not party_on
    w = bpy.context.scene.world.node_tree.nodes['Background']
    w.inputs['Strength'].default_value = 1.0 if dark_on else 0.0
    for name, s in EMIT_PARTY.items():
        m = bpy.data.materials.get(name)
        if m:
            m.node_tree.nodes['Principled BSDF'].inputs['Emission Strength'].default_value = s if party_on else 0.0


def camera_for(shot, fov=45.0):
    s = L['shots'][shot]
    cam_d = bpy.data.cameras.get('cam') or bpy.data.cameras.new('cam')
    cam_d.sensor_fit = 'VERTICAL'
    cam_d.angle_y = math.radians(fov)
    cam_d.clip_start = 0.05
    cam = bpy.data.objects.get('cam') or bpy.data.objects.new('cam', cam_d)
    if cam.name not in bpy.context.scene.collection.objects:
        bpy.context.scene.collection.objects.link(cam)
    p = B(*s['position'])
    t = B(*s['target'])
    cam.location = p
    cam.rotation_euler = (t - p).to_track_quat('-Z', 'Y').to_euler()
    bpy.context.scene.camera = cam
    return cam


def render(path, res, samples):
    sc = bpy.context.scene
    w, h = [int(v) for v in res.split('x')]
    sc.render.resolution_x, sc.render.resolution_y = w, h
    sc.render.resolution_percentage = 100
    sc.cycles.samples = samples
    sc.cycles.use_denoising = True
    sc.render.image_settings.file_format = 'PNG'
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)


def stage_relight():
    """Moves the DARK window light in the saved scene (no rebuild, so the
    lightmap UVs and the PARTY bake stay valid); then bake --states dark."""
    bpy.ops.wm.open_mainfile(filepath=BLEND)
    wx0, wx1, wy0, wy1 = WIN['x0'], WIN['x1'], WIN['y0'], WIN['y1']
    win = bpy.data.objects['dark_window']
    win.location = B((wx0 + wx1) / 2, (wy0 + wy1) / 2 - 0.2, -Z - 1.2)
    win.data.energy = float(opt('--power', '26'))
    win.data.size = (wx1 - wx0) * 1.6
    win.data.size_y = (wy1 - wy0) * 1.3
    bpy.ops.wm.save_as_mainfile(filepath=BLEND)


def stage_preview():
    bpy.ops.wm.open_mainfile(filepath=BLEND)
    setup_cycles()
    shot = opt('--shot', 'wide')
    camera_for(shot)
    for st in opt('--states', 'dark,party,lit').split(','):
        set_state(st)
        render(os.path.join(CACHE, f'preview-{shot}-{st}.png'), opt('--res', '800x500'), int(opt('--samples', '64')))


# --------------------------------------------------------------------------
# Bake
# --------------------------------------------------------------------------

def denoise_exr(src, dst):
    """OIDN (compositor Denoise node) over a baked lightmap. Runs a
    Workbench 'render' of an empty camera just to evaluate the compositor."""
    sc = bpy.context.scene
    engine = sc.render.engine
    res = (sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage)
    img = bpy.data.images.load(src, check_existing=False)
    ng = bpy.data.node_groups.new('lm_denoise', 'CompositorNodeTree')
    ng.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
    n_img = ng.nodes.new('CompositorNodeImage')
    n_img.image = img
    n_dn = ng.nodes.new('CompositorNodeDenoise')
    for key, val in (('HDR', True), ('Prefilter', 'ACCURATE'), ('Quality', 'HIGH')):
        sock = n_dn.inputs.get(key)
        try:
            if sock is not None:
                sock.default_value = val
        except Exception as e:
            print('denoise option', key, e)
    out = ng.nodes.new('NodeGroupOutput')
    ng.links.new(n_img.outputs['Image'], n_dn.inputs['Image'])
    ng.links.new(n_dn.outputs['Image'], out.inputs[0])
    prev_group = sc.compositing_node_group
    sc.compositing_node_group = ng
    sc.render.engine = 'BLENDER_WORKBENCH'
    sc.render.resolution_x, sc.render.resolution_y = img.size
    sc.render.resolution_percentage = 100
    fmt = sc.render.image_settings.file_format
    sc.render.image_settings.file_format = 'OPEN_EXR'
    sc.render.filepath = dst
    hidden = []
    for o in sc.objects:
        if not o.hide_render:
            o.hide_render = True
            hidden.append(o)
    bpy.ops.render.render(write_still=True)
    for o in hidden:
        o.hide_render = False
    sc.render.image_settings.file_format = fmt
    sc.compositing_node_group = prev_group
    sc.render.engine = engine
    sc.render.resolution_x, sc.render.resolution_y, sc.render.resolution_percentage = res
    bpy.data.node_groups.remove(ng)
    bpy.data.images.remove(img)
    return bpy.data.images.load(dst, check_existing=False)


def stage_bake():
    import numpy as np
    bpy.ops.wm.open_mainfile(filepath=BLEND)
    samples = int(opt('--samples', '512'))
    size = int(opt('--size', '2048'))
    setup_cycles(samples)
    sc = bpy.context.scene
    sc.cycles.use_denoising = False
    sc.render.bake.margin = 16
    sc.render.bake.margin_type = 'EXTEND'
    room = bpy.data.objects['ROOM']
    room.data.uv_layers.active = room.data.uv_layers['LM']
    out = {}
    for state in opt('--states', 'dark,party').split(','):
        img = bpy.data.images.get(f'LM_{state}') or bpy.data.images.new(f'LM_{state}', size, size, float_buffer=True, alpha=True)
        for m in room.data.materials:
            nt = m.node_tree
            n = nt.nodes.get('LM_BAKE') or nt.nodes.new('ShaderNodeTexImage')
            n.name = 'LM_BAKE'
            n.image = img
            n.select = True
            nt.nodes.active = n
        set_state(state)
        bpy.ops.object.select_all(action='DESELECT')
        room.select_set(True)
        bpy.context.view_layer.objects.active = room
        bpy.ops.object.bake(type='DIFFUSE', pass_filter={'DIRECT', 'INDIRECT'}, margin=16, use_clear=True)
        exr = os.path.join(CACHE, f'lm-{state}.exr')
        img.filepath_raw = exr
        img.file_format = 'OPEN_EXR'
        img.save()
        # Denoise (OIDN), then encode sqrt(E / Emax) into 8 bits.
        dn = denoise_exr(exr, os.path.join(CACHE, f'lm-{state}-dn.exr'))
        rgb = np.array(dn.pixels[:], dtype=np.float32).reshape(size, size, 4)[:, :, :3]
        rgb = np.maximum(rgb, 0)
        px = np.array(img.pixels[:], dtype=np.float32).reshape(size, size, 4)
        lum = rgb.max(axis=2)
        mask = px[:, :, 3] > 0.5
        emax = float(np.percentile(lum[mask], 99.6)) if mask.any() else 1.0
        enc = np.sqrt(np.clip(rgb / emax, 0, 1))
        png = bpy.data.images.new(f'LM8_{state}', size, size, alpha=False)
        png.colorspace_settings.name = 'Non-Color'
        o = np.ones((size, size, 4), dtype=np.float32)
        o[:, :, :3] = enc
        png.pixels[:] = o.ravel()
        png.filepath_raw = os.path.join(CACHE, f'lm-{state}.png')
        png.file_format = 'PNG'
        png.save()
        out[state] = {'emax': emax, 'mean': float(lum[mask].mean())}
        print('BAKED', state, out[state])
    prev = {}
    bj = os.path.join(CACHE, 'bake.json')
    if os.path.exists(bj):
        prev = json.load(open(bj))
    prev.update(out)
    json.dump(prev, open(bj, 'w'), indent=1)
    for m in room.data.materials:
        n = m.node_tree.nodes.get('LM_BAKE')
        if n:
            m.node_tree.nodes.remove(n)
    room.data.uv_layers.active = room.data.uv_layers['UVMap']
    bpy.ops.wm.save_as_mainfile(filepath=BLEND)


# --------------------------------------------------------------------------
# Export
# --------------------------------------------------------------------------

def stage_export():
    bpy.ops.wm.open_mainfile(filepath=BLEND)
    set_state('lit')
    # The frame's artwork is replaced by the card photo at runtime: export a
    # plain material (its Poly Haven maps are not needed, one failed to save).
    photo = bpy.data.objects.get('PHOTO')
    if photo:
        for m in photo.data.materials:
            for n in [n for n in m.node_tree.nodes if n.type == 'TEX_IMAGE']:
                m.node_tree.nodes.remove(n)
            m.name = 'photo_artwork'
    # The exporter only writes UV maps that a material samples, so the
    # lightmap UVs travel as a custom corner attribute (_LM, exported by
    # export_attributes); src/room/loader.js turns it into uv1.
    import numpy as np
    room = bpy.data.objects['ROOM']
    me = room.data
    lm = me.uv_layers['LM']
    data = np.zeros(len(me.loops) * 2, dtype=np.float32)
    lm.data.foreach_get('uv', data)
    # glTF's v runs downwards; UVs get that flip from the exporter, a plain
    # attribute does not.
    data[1::2] = 1.0 - data[1::2]
    if '_LM' in me.attributes:
        me.attributes.remove(me.attributes['_LM'])
    attr = me.attributes.new('_LM', 'FLOAT2', 'CORNER')
    attr.data.foreach_set('vector', data)
    bpy.ops.object.select_all(action='DESELECT')
    for cname in ('export', 'export_nobake'):
        for o in bpy.data.collections[cname].objects:
            o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=os.path.join(CACHE, 'room-raw.glb'), export_format='GLB', use_selection=True,
        export_apply=True, export_texcoords=True, export_normals=True, export_tangents=False,
        export_materials='EXPORT', export_image_format='WEBP', export_cameras=False, export_lights=False, export_attributes=True,
        export_yup=True)
    print('EXPORTED')


# --------------------------------------------------------------------------
# Posters
# --------------------------------------------------------------------------

def stage_poster():
    """Cycles stills of the dressed room. The party props and the cake come
    from the runtime itself (cache/props.glb, exported by the dev harness), so
    the poster shows exactly what the 3D scene will; flames become small
    emissive teardrops with a 1850 K point light each."""
    bpy.ops.wm.open_mainfile(filepath=BLEND)
    setup_cycles()
    party_emit, candles, flames = [], [], []
    props = os.path.join(CACHE, 'props.glb')
    if os.path.exists(props):
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=props)
        new = [o for o in bpy.data.objects if o not in before]
        flame_m = bpy.data.materials.new('flame_emit')
        flame_m.use_nodes = True
        fp = flame_m.node_tree.nodes['Principled BSDF']
        fp.inputs['Base Color'].default_value = (0, 0, 0, 1)
        fp.inputs['Emission Color'].default_value = (*kelvin(1850), 1)
        fp.inputs['Emission Strength'].default_value = 60.0
        for o in new:
            if o.name.startswith('CANDLE_'):
                loc = o.matrix_world.translation.copy()
                bpy.ops.mesh.primitive_uv_sphere_add(radius=0.0035, location=loc + Vector((0, 0, 0.004)), segments=12, ring_count=8)
                f = bpy.context.active_object
                f.scale = (1, 1, 2.4)
                f.data.materials.append(flame_m)
                flames.append(f)
                l = light(f'candle_{o.name}', 'POINT', loc + Vector((0, 0, 0.012)), 0.5, kelvin(1850), bpy.context.scene.collection, size=0.004)
                candles.append(l)
            elif o.name.startswith(('fairy-bulbs', 'name-sign')):
                party_emit.append(o)
        print('PROPS', len(new), 'candles', len(candles))
    shot = opt('--shot', 'poster')
    camera_for(shot, float(opt('--fov', '45')))
    sc = bpy.context.scene
    for st in opt('--states', 'dark,lit').split(','):
        set_state(st)
        for o in party_emit + candles + flames:
            o.hide_render = st == 'dark'
        sc.view_settings.exposure = float(opt('--dark-exposure', '0.4')) if st == 'dark' else float(opt('--lit-exposure', '-0.2'))
        render(os.path.join(CACHE, f'poster-{st}.png'), opt('--res', '1280x800'), int(opt('--samples', '256')))


{'build': stage_build, 'relight': stage_relight, 'preview': stage_preview, 'bake': stage_bake, 'export': stage_export, 'poster': stage_poster}[STAGE]()
