# Fault-injection proof for validate.py: builds the real kit, then breaks it three ways and
# asserts each break is caught. Run: npm run art:validate:selftest
import os
import sys

import bpy

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import author_kit  # noqa: E402
import validate  # noqa: E402

author_kit.clear_scene()
author_kit.setup_ao_bake()
for build in (author_kit.build_helmet, author_kit.build_boot, author_kit.build_rifle, author_kit.build_pack):
    build()
import author_kinds  # noqa: E402

author_kinds.build_all()
names = validate.kit_part_names("KitPart")
validate.validate_scene(names, label="clean kit")


def expect_fail(label, fn):
    fn()
    try:
        validate.validate_scene(names, label=label)
    except validate.ValidationError:
        print(f"[selftest] caught: {label}")
        return
    print(f"[selftest] NOT CAUGHT: {label}")
    sys.exit(1)


def rename():
    bpy.data.objects["helmet-scout"].name = "helmet-scout-v2"


def flip():
    bpy.data.objects["helmet-scout-v2"].name = "helmet-scout"
    obj = bpy.data.objects["boot"]
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.flip_normals()
    bpy.ops.object.mode_set(mode="OBJECT")


def stray():
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="SELECT")
    bpy.ops.mesh.flip_normals()
    bpy.ops.object.mode_set(mode="OBJECT")
    bpy.ops.mesh.primitive_cube_add(size=1)


expect_fail("renamed part", rename)
expect_fail("flipped shell", flip)
expect_fail("stray unjoined primitive", stray)
print("[selftest] validator catches all three injected faults")
