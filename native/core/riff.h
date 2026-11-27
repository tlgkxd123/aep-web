/**
 * RIFX (big-endian RIFF) chunk tree of an After Effects project, as src/aep/riff.ts reads it. Chunks point into the
 * file's bytes, which the caller keeps alive for as long as the tree.
 */
#pragma once

#include <memory>
#include <string>
#include <vector>

#include "types.h"

namespace aep
{

/** A four-character chunk or list type, packed big-endian so 'LIST' compares as one integer. */
typedef u32 FourCC;

constexpr FourCC MakeFourCC(const char (&text)[5])
{
	return (u32(u8(text[0])) << 24) | (u32(u8(text[1])) << 16) | (u32(u8(text[2])) << 8) | u32(u8(text[3]));
}

/** One chunk: its body and, for containers, its children. */
class CChunk
{
public:
	FourCC m_uType = 0;
	/** The list type of a LIST or RIFX chunk, else 0. */
	FourCC m_uListType = 0;
	/** File offset of the 8-byte header. */
	size_t m_uOffset = 0;
	/** Body bytes; for LIST and RIFX chunks the 4-byte list type is left out. */
	const u8* m_pData = nullptr;
	size_t m_uSize = 0;
	/** Set when the declared size overran the parent; the tree below is partial. */
	bool m_bTruncated = false;
	std::vector<CChunk> m_Children;

	bool IsList(FourCC listType) const { return m_uType == MakeFourCC("LIST") && m_uListType == listType; }

	/** The first child of `type`, or null. */
	const CChunk* Child(FourCC type) const;
	/** The first LIST child of `listType`, or null. */
	const CChunk* List(FourCC listType) const;
	/** Every LIST child of `listType`, in order. */
	std::vector<const CChunk*> Lists(FourCC listType) const;
};

/** A parsed project file: the RIFX tree. */
struct sRifxFile
{
	CChunk m_Root;
	std::string m_Error;
};

/** Reads the chunk tree of `size` bytes at `data`; false with `error` set when the bytes are not a RIFX file. */
bool ReadRifx(const u8* data, size_t size, sRifxFile& file, std::string& error);

/** Null-safe helpers mirroring findChild, findList and filterLists. */
inline const CChunk* FindChild(const CChunk* parent, FourCC type)
{
	return parent ? parent->Child(type) : nullptr;
}

inline const CChunk* FindList(const CChunk* parent, FourCC listType)
{
	return parent ? parent->List(listType) : nullptr;
}

} /** namespace aep */
