/**
 * Layer transforms (src/aep/transform.ts): local and world (parented) matrices and the comp camera.
 */
#pragma once

#include "model.h"

namespace aep
{

struct sVec3
{
	f64 x = 0;
	f64 y = 0;
	f64 z = 0;
};

/** 4x4 matrix, row-major, acting on column vectors. */
class CMat4
{
public:
	f64 m[16] = { 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 };

	static CMat4 Translation(f64 x, f64 y, f64 z);
	static CMat4 Scale(f64 x, f64 y, f64 z);
	static CMat4 RotateX(f64 degrees);
	static CMat4 RotateY(f64 degrees);
	static CMat4 RotateZ(f64 degrees);

	/** `this @ other`. */
	CMat4 operator*(const CMat4& other) const;
	sVec3 TransformPoint(const sVec3& p) const;
	sVec3 TransformVector(const sVec3& v) const;
	/** The inverse; false (and identity) when the matrix is singular. */
	bool Inverse(CMat4& out) const;
};

struct sLocalTransform
{
	sVec3 m_Position;
	sVec3 m_Anchor;
	sVec3 m_Scale;
	sVec3 m_Orientation;
	f64 m_fRotateX = 0;
	f64 m_fRotateY = 0;
	f64 m_fRotateZ = 0;
	f64 m_fOpacity = 100;
};

sLocalTransform LocalTransform(const CLayer& layer, f64 time);

/** T(position) . Rx.Ry.Rz(orientation) . Rx(x).Ry(y).Rz(z) . S(scale) . T(-anchor). */
CMat4 LocalMatrix(const sLocalTransform& t);

/** Layer space to world (comp 3D) space, composed through the parent chain. */
CMat4 WorldMatrix(const CLayer& layer, const CItem& comp, f64 time);

/** AE's default comp camera zoom: the 50mm preset, in square pixels. */
f64 DefaultCameraZoom(const CItem& comp);

struct sCamera
{
	sVec3 m_Position;
	/** Camera-to-world rotation. */
	CMat4 m_Rotation;
	/** Distance from the camera to its image plane, in pixels. */
	f64 m_fZoom = 0;
};

/** The front-most enabled camera layer active at `time`, or null for the default camera. */
const CLayer* ActiveCameraLayer(const CItem& comp, f64 time);

/** The camera at `time`; a null `cameraLayer` is AE's default comp camera. */
sCamera CameraAt(const CItem& comp, f64 time, const CLayer* cameraLayer);

} /** namespace aep */
