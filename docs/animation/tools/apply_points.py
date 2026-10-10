"""Pose points + squelette dans une animation cotracker-bones (tracking à refaire) : python3 apply_points.py <pid> <anim> <points.json> <skeleton.json>"""
import json, sys, auth
pid, anim_name, pts_p, sk_p = sys.argv[1:5]
pts=json.load(open(pts_p)); sk=json.load(open(sk_p))
a=auth.set_animation_mesh(pid, anim_name, {'cotrackerPoints': pts, 'cotrackerSkeleton': sk, 'cotrackerTrackingValidated': False, 'cotrackerBonesValidated': False, 'cotrackerLBSValidated': False,
                                           'cotrackerLBSParams': {'mode':'lbs-arap','weightPower':4,'weightEpsilon':1,'arapIterations':5,'weightSmoothIterations':0,'weightSmoothAlpha':0.5,'contourArapLambda':1,'contourArapIterations':2,'areaPostIterations':3,'areaPostStrength':0}})
print(anim_name, ':', len(a['mesh']['cotrackerPoints']), 'points,', len(a['mesh']['cotrackerSkeleton']['legs']), 'chaînes (LBS power 4 / ARAP 5)')
