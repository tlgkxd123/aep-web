/**
 * Port of src/aep/transform.ts (from py-aep's resolvers/transform.py, MIT, https://github.com/forticheprod/py-aep).
 */
#include "transform.h"

#include <cmath>
#include <set>

#include "evaluate.h"

namespace aep
{

namespace
{

const f64 DEG2RAD = 3.14159265358979323846 / 180;
const f64 EPSILON = 1e-10;

CMat4 FromRows(const f64 (&v)[16])
{
	CMat4 out;
	for (s32 i = 0; i < 16; i++)
	{
		out.m[i] = v[i];
	}
	return out;
}

/** A transform property's value; separated Position is composed from its followers. */
CValue TransformValue(const CLayer& layer, const char* matchName, f64 time)
{
	const CPropertyNode* transform = layer.m_Properties.FindGroup("ADBE Transform Group");
	const CPropertyNode* prop = transform ? transform->FindProperty(matchName) : nullptr;
	if (!prop)
	{
		return CValue();
	}
	return CurrentValue(*prop, time, layer, transform);
}

sVec3 Vec3(const CValue& v)
{
	if (v.IsVector())
	{
		return { v.At(0), v.At(1), v.At(2) };
	}
	return { v.IsNumber() ? v.m_V[0] : 0, 0, 0 };
}

f64 Scalar(const CValue& v)
{
	return v.IsNumeric() ? v.At(0) : 0;
}

sVec3 Sub(const sVec3& a, const sVec3& b)
{
	return { a.x - b.x, a.y - b.y, a.z - b.z };
}

sVec3 Cross(const sVec3& a, const sVec3& b)
{
	return { a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x };
}

f64 Norm(const sVec3& v)
{
	const f64 c[3] = { v.x, v.y, v.z };
	return Hypot(c, 3);
}

sVec3 Normalize(const sVec3& v)
{
	const f64 n = Norm(v);
	return n > 0 ? sVec3{ v.x / n, v.y / n, v.z / n } : sVec3{};
}

/** A two-node camera's rotation: +Z toward the point of interest, roll referenced to +Y. */
CMat4 LookAt(const sVec3& eye, const sVec3& target)
{
	const sVec3 delta = Sub(target, eye);
	const sVec3 forward = Norm(delta) < EPSILON ? sVec3{ 0, 0, 1 } : Normalize(delta);
	const sVec3 c = Cross({ 0, 1, 0 }, forward);
	const sVec3 xAxis = Norm(c) < EPSILON ? sVec3{ 1, 0, 0 } : Normalize(c);
	const sVec3 yAxis = Cross(forward, xAxis);
	return FromRows({ xAxis.x, yAxis.x, forward.x, 0, xAxis.y, yAxis.y, forward.y, 0, xAxis.z, yAxis.z, forward.z, 0, 0, 0, 0, 1 });
}

} /** namespace */

CMat4 CMat4::Translation(f64 x, f64 y, f64 z)
{
	return FromRows({ 1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1 });
}

CMat4 CMat4::Scale(f64 x, f64 y, f64 z)
{
	return FromRows({ x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1 });
}

CMat4 CMat4::RotateX(f64 degrees)
{
	const f64 c = std::cos(degrees * DEG2RAD);
	const f64 s = std::sin(degrees * DEG2RAD);
	return FromRows({ 1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1 });
}

CMat4 CMat4::RotateY(f64 degrees)
{
	const f64 c = std::cos(degrees * DEG2RAD);
	const f64 s = std::sin(degrees * DEG2RAD);
	return FromRows({ c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1 });
}

CMat4 CMat4::RotateZ(f64 degrees)
{
	const f64 c = std::cos(degrees * DEG2RAD);
	const f64 s = std::sin(degrees * DEG2RAD);
	return FromRows({ c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1 });
}

CMat4 CMat4::operator*(const CMat4& other) const
{
	const f64* a = m;
	const f64* b = other.m;
	CMat4 out;
	for (s32 r = 0; r < 4; r++)
	{
		for (s32 c = 0; c < 4; c++)
		{
			out.m[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
		}
	}
	return out;
}

sVec3 CMat4::TransformPoint(const sVec3& p) const
{
	f64 w = m[12] * p.x + m[13] * p.y + m[14] * p.z + m[15];
	if (w == 0 || std::isnan(w))
	{
		w = 1;
	}
	return {
		(m[0] * p.x + m[1] * p.y + m[2] * p.z + m[3]) / w,
		(m[4] * p.x + m[5] * p.y + m[6] * p.z + m[7]) / w,
		(m[8] * p.x + m[9] * p.y + m[10] * p.z + m[11]) / w,
	};
}

sVec3 CMat4::TransformVector(const sVec3& v) const
{
	return { m[0] * v.x + m[1] * v.y + m[2] * v.z, m[4] * v.x + m[5] * v.y + m[6] * v.z, m[8] * v.x + m[9] * v.y + m[10] * v.z };
}

bool CMat4::Inverse(CMat4& out) const
{
	f64 inv[16];
	inv[0] = m[5] * m[10] * m[15] - m[5] * m[11] * m[14] - m[9] * m[6] * m[15] + m[9] * m[7] * m[14] + m[13] * m[6] * m[11] - m[13] * m[7] * m[10];
	inv[4] = -m[4] * m[10] * m[15] + m[4] * m[11] * m[14] + m[8] * m[6] * m[15] - m[8] * m[7] * m[14] - m[12] * m[6] * m[11] + m[12] * m[7] * m[10];
	inv[8] = m[4] * m[9] * m[15] - m[4] * m[11] * m[13] - m[8] * m[5] * m[15] + m[8] * m[7] * m[13] + m[12] * m[5] * m[11] - m[12] * m[7] * m[9];
	inv[12] = -m[4] * m[9] * m[14] + m[4] * m[10] * m[13] + m[8] * m[5] * m[14] - m[8] * m[6] * m[13] - m[12] * m[5] * m[10] + m[12] * m[6] * m[9];
	inv[1] = -m[1] * m[10] * m[15] + m[1] * m[11] * m[14] + m[9] * m[2] * m[15] - m[9] * m[3] * m[14] - m[13] * m[2] * m[11] + m[13] * m[3] * m[10];
	inv[5] = m[0] * m[10] * m[15] - m[0] * m[11] * m[14] - m[8] * m[2] * m[15] + m[8] * m[3] * m[14] + m[12] * m[2] * m[11] - m[12] * m[3] * m[10];
	inv[9] = -m[0] * m[9] * m[15] + m[0] * m[11] * m[13] + m[8] * m[1] * m[15] - m[8] * m[3] * m[13] - m[12] * m[1] * m[11] + m[12] * m[3] * m[9];
	inv[13] = m[0] * m[9] * m[14] - m[0] * m[10] * m[13] - m[8] * m[1] * m[14] + m[8] * m[2] * m[13] + m[12] * m[1] * m[10] - m[12] * m[2] * m[9];
	inv[2] = m[1] * m[6] * m[15] - m[1] * m[7] * m[14] - m[5] * m[2] * m[15] + m[5] * m[3] * m[14] + m[13] * m[2] * m[7] - m[13] * m[3] * m[6];
	inv[6] = -m[0] * m[6] * m[15] + m[0] * m[7] * m[14] + m[4] * m[2] * m[15] - m[4] * m[3] * m[14] - m[12] * m[2] * m[7] + m[12] * m[3] * m[6];
	inv[10] = m[0] * m[5] * m[15] - m[0] * m[7] * m[13] - m[4] * m[1] * m[15] + m[4] * m[3] * m[13] + m[12] * m[1] * m[7] - m[12] * m[3] * m[5];
	inv[14] = -m[0] * m[5] * m[14] + m[0] * m[6] * m[13] + m[4] * m[1] * m[14] - m[4] * m[2] * m[13] - m[12] * m[1] * m[6] + m[12] * m[2] * m[5];
	inv[3] = -m[1] * m[6] * m[11] + m[1] * m[7] * m[10] + m[5] * m[2] * m[11] - m[5] * m[3] * m[10] - m[9] * m[2] * m[7] + m[9] * m[3] * m[6];
	inv[7] = m[0] * m[6] * m[11] - m[0] * m[7] * m[10] - m[4] * m[2] * m[11] + m[4] * m[3] * m[10] + m[8] * m[2] * m[7] - m[8] * m[3] * m[6];
	inv[11] = -m[0] * m[5] * m[11] + m[0] * m[7] * m[9] + m[4] * m[1] * m[11] - m[4] * m[3] * m[9] - m[8] * m[1] * m[7] + m[8] * m[3] * m[5];
	inv[15] = m[0] * m[5] * m[10] - m[0] * m[6] * m[9] - m[4] * m[1] * m[10] + m[4] * m[2] * m[9] + m[8] * m[1] * m[6] - m[8] * m[2] * m[5];
	const f64 det = m[0] * inv[0] + m[1] * inv[4] + m[2] * inv[8] + m[3] * inv[12];
	if (!(std::fabs(det) >= 1e-300))
	{
		out = CMat4();
		return false;
	}
	for (s32 i = 0; i < 16; i++)
	{
		out.m[i] = inv[i] / det;
	}
	return true;
}

sLocalTransform LocalTransform(const CLayer& layer, f64 time)
{
	sLocalTransform t;
	t.m_Position = Vec3(TransformValue(layer, "ADBE Position", time));
	t.m_Anchor = Vec3(TransformValue(layer, "ADBE Anchor Point", time));
	t.m_Scale = Vec3(TransformValue(layer, "ADBE Scale", time));
	t.m_Orientation = Vec3(TransformValue(layer, "ADBE Orientation", time));
	t.m_fRotateX = Scalar(TransformValue(layer, "ADBE Rotate X", time));
	t.m_fRotateY = Scalar(TransformValue(layer, "ADBE Rotate Y", time));
	t.m_fRotateZ = Scalar(TransformValue(layer, "ADBE Rotate Z", time));
	t.m_fOpacity = Scalar(TransformValue(layer, "ADBE Opacity", time));
	return t;
}

CMat4 LocalMatrix(const sLocalTransform& t)
{
	const sVec3& o = t.m_Orientation;
	const bool is3D = t.m_fRotateX != 0 || t.m_fRotateY != 0 || o.x != 0 || o.y != 0 || o.z != 0;
	CMat4 m = CMat4::Translation(-t.m_Anchor.x, -t.m_Anchor.y, -t.m_Anchor.z);
	m = CMat4::Scale(t.m_Scale.x / 100, t.m_Scale.y / 100, t.m_Scale.z / 100) * m;
	m = CMat4::RotateZ(t.m_fRotateZ) * m;
	m = CMat4::RotateY(t.m_fRotateY) * m;
	m = CMat4::RotateX(t.m_fRotateX) * m;
	if (is3D)
	{
		m = CMat4::RotateZ(o.z) * m;
		m = CMat4::RotateY(o.y) * m;
		m = CMat4::RotateX(o.x) * m;
	}
	return CMat4::Translation(t.m_Position.x, t.m_Position.y, t.m_Position.z) * m;
}

CMat4 WorldMatrix(const CLayer& layer, const CItem& comp, f64 time)
{
	const CLayer* chain[64];
	s32 count = 0;
	std::vector<const CLayer*> longChain;
	std::set<u32> seen;
	for (const CLayer* current = &layer; current && !seen.count(current->m_uId);)
	{
		seen.insert(current->m_uId);
		if (count < 64)
		{
			chain[count++] = current;
		}
		else
		{
			longChain.push_back(current);
		}
		current = current->m_uParentId ? comp.LayerById(current->m_uParentId) : nullptr;
	}
	CMat4 m;
	for (s32 i = s32(longChain.size()) - 1; i >= 0; i--)
	{
		m = m * LocalMatrix(LocalTransform(*longChain[size_t(i)], time));
	}
	for (s32 i = count - 1; i >= 0; i--)
	{
		m = m * LocalMatrix(LocalTransform(*chain[i], time));
	}
	return m;
}

f64 DefaultCameraZoom(const CItem& comp)
{
	return (comp.m_fWidth * comp.m_fPixelAspect) / 0.72;
}

const CLayer* ActiveCameraLayer(const CItem& comp, f64 time)
{
	for (const auto& l : comp.m_Layers)
	{
		if (l->m_eType == LAYER_CAMERA && l->m_bEnabled && l->m_fInPoint <= time && time < l->m_fOutPoint)
		{
			return l.get();
		}
	}
	return nullptr;
}

sCamera CameraAt(const CItem& comp, f64 time, const CLayer* cameraLayer)
{
	sCamera camera;
	if (!cameraLayer)
	{
		camera.m_fZoom = DefaultCameraZoom(comp);
		camera.m_Position = { comp.m_fWidth / 2, comp.m_fHeight / 2, -camera.m_fZoom };
		return camera;
	}
	const sLocalTransform t = LocalTransform(*cameraLayer, time);
	CMat4 rotation = cameraLayer->m_uAutoOrient == AUTO_ORIENT_CAMERA_OR_POINT_OF_INTEREST ? LookAt(t.m_Position, t.m_Anchor) : CMat4();
	rotation = rotation * CMat4::RotateX(t.m_Orientation.x) * CMat4::RotateY(t.m_Orientation.y) * CMat4::RotateZ(t.m_Orientation.z) *
		CMat4::RotateX(t.m_fRotateX) * CMat4::RotateY(t.m_fRotateY) * CMat4::RotateZ(t.m_fRotateZ);
	const CPropertyNode* options = cameraLayer->m_Properties.FindGroup("ADBE Camera Options Group");
	const CPropertyNode* zoomProp = options ? options->FindProperty("ADBE Camera Zoom") : nullptr;
	if (zoomProp)
	{
		camera.m_fZoom = Scalar(CurrentValue(*zoomProp, time, *cameraLayer));
	}
	else
	{
		/** The default the TypeScript side synthesizes for a camera that stores no Zoom (rounded as the file would). */
		camera.m_fZoom = std::round(DefaultCameraZoom(comp) * 1e8) / 1e8;
	}
	camera.m_Position = t.m_Position;
	camera.m_Rotation = rotation;
	return camera;
}

} /** namespace aep */
