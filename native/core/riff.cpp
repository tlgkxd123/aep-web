/**
 * RIFX chunk tree reader (src/aep/riff.ts).
 */
#include "riff.h"

namespace aep
{

namespace
{

/** Chunks whose body is a run of child chunks without a list-type prefix. */
bool IsContainerType(FourCC type)
{
	return type == MakeFourCC("fnam") || type == MakeFourCC("pdnm") || type == MakeFourCC("RCom") ||
		type == MakeFourCC("tdsn") || type == MakeFourCC("vfdn");
}

/** LIST subtypes whose body is opaque binary rather than child chunks. */
bool IsOpaqueListType(FourCC listType)
{
	return listType == MakeFourCC("btdk");
}

u32 ReadU32(const u8* p)
{
	return (u32(p[0]) << 24) | (u32(p[1]) << 16) | (u32(p[2]) << 8) | u32(p[3]);
}

void BuildChunk(const u8* file, CChunk& chunk, size_t bodyStart, size_t bodyEnd, s32 depth);

/** Reads the chunks between `start` and `end` into `out`. */
void ReadChildren(const u8* file, size_t start, size_t end, std::vector<CChunk>& out, s32 depth)
{
	size_t pos = start;
	while (pos + 8 <= end)
	{
		CChunk chunk;
		chunk.m_uType = ReadU32(file + pos);
		chunk.m_uOffset = pos;
		const u32 size = ReadU32(file + pos + 4);
		const size_t bodyStart = pos + 8;
		size_t bodyEnd = bodyStart + size;
		if (bodyEnd > end)
		{
			chunk.m_bTruncated = true;
			bodyEnd = end;
		}
		BuildChunk(file, chunk, bodyStart, bodyEnd, depth + 1);
		const bool truncated = chunk.m_bTruncated;
		out.push_back(std::move(chunk));
		if (truncated)
		{
			return;
		}
		pos = bodyEnd + (size & 1);
	}
}

void BuildChunk(const u8* file, CChunk& chunk, size_t bodyStart, size_t bodyEnd, s32 depth)
{
	/** A hostile file could nest lists without end; AE's own files stay far below this. */
	const s32 MAX_DEPTH = 256;
	const bool listLike = chunk.m_uType == MakeFourCC("LIST") || chunk.m_uType == MakeFourCC("RIFX");
	if (listLike && bodyEnd - bodyStart >= 4)
	{
		chunk.m_uListType = ReadU32(file + bodyStart);
		chunk.m_pData = file + bodyStart + 4;
		chunk.m_uSize = bodyEnd - bodyStart - 4;
		if (!IsOpaqueListType(chunk.m_uListType) && depth < MAX_DEPTH)
		{
			ReadChildren(file, bodyStart + 4, bodyEnd, chunk.m_Children, depth);
		}
		return;
	}
	chunk.m_pData = file + bodyStart;
	chunk.m_uSize = bodyEnd - bodyStart;
	if (IsContainerType(chunk.m_uType) && depth < MAX_DEPTH)
	{
		ReadChildren(file, bodyStart, bodyEnd, chunk.m_Children, depth);
	}
}

} /** namespace */

const CChunk* CChunk::Child(FourCC type) const
{
	for (const CChunk& child : m_Children)
	{
		if (child.m_uType == type)
		{
			return &child;
		}
	}
	return nullptr;
}

const CChunk* CChunk::List(FourCC listType) const
{
	for (const CChunk& child : m_Children)
	{
		if (child.IsList(listType))
		{
			return &child;
		}
	}
	return nullptr;
}

std::vector<const CChunk*> CChunk::Lists(FourCC listType) const
{
	std::vector<const CChunk*> lists;
	for (const CChunk& child : m_Children)
	{
		if (child.IsList(listType))
		{
			lists.push_back(&child);
		}
	}
	return lists;
}

bool ReadRifx(const u8* data, size_t size, sRifxFile& file, std::string& error)
{
	if (size < 12 || ReadU32(data) != MakeFourCC("RIFX"))
	{
		error = "Not an After Effects project: missing RIFX header";
		return false;
	}
	const u32 declared = ReadU32(data + 4);
	size_t end = size_t(8) + declared;
	if (end > size)
	{
		file.m_Error = "RIFX size exceeds file length";
		end = size;
	}
	file.m_Root = CChunk();
	file.m_Root.m_uType = MakeFourCC("RIFX");
	BuildChunk(data, file.m_Root, 8, end, 0);
	return true;
}

} /** namespace aep */
