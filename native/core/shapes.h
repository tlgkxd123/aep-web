/**
 * Shape layers as the native engine draws them (src/render/shapes.ts planShapeLayer): paths, Trim Paths, Repeater,
 * group transforms, fills, strokes and gradients, evaluated into engine paints.
 */
#pragma once

#include "../src/plan.h"
#include "model.h"

namespace aep
{

struct sShapeLayerPlan
{
	/** Image position of the first content pixel, relative to the layer origin (image pixels). */
	f64 m_fOriginX = 0;
	f64 m_fOriginY = 0;
	f64 m_fWidth = 0;
	f64 m_fHeight = 0;
	/** Bottom first. */
	std::vector<aevk::ShapePaint> m_Paints;
	/** Dashed strokes, which the engine does not draw yet. */
	bool m_bDashed = false;
};

/**
 * What a shape layer draws at `time`, at `imageScale` image pixels per layer pixel with a `pad` border; false when it
 * draws nothing.
 */
bool PlanShapeLayer(const CLayer& layer, f64 time, f64 imageScale, f64 pad, sShapeLayerPlan& out);

} /** namespace aep */
