/**
 * Choosing a project on desktop without a platform dialog: a folder browser that lists folders and .aep files, and
 * the projects opened recently, kept in a small text file.
 */
#pragma once

#include <string>
#include <vector>

#include "types.h"

namespace aep
{

/** A folder's entries the browser shows: subfolders, then projects, by name. */
struct sFolderEntry
{
	std::string m_Name;
	std::string m_Path;
	bool m_bFolder = false;
	u64 m_uBytes = 0;
};

/** The entries of `folder` (folders and .aep files, hidden ones left out); false with `error` set when it cannot be read. */
bool ListFolder(const std::string& folder, std::vector<sFolderEntry>& out, std::string& error);
/** The folder above `folder`, or `folder` itself at a root. */
std::string ParentFolder(const std::string& folder);
/** Where the browser starts: the user's home folder (or the drive's root). */
std::string HomeFolder();
/** Filesystem roots to jump to (drive letters on Windows, / elsewhere). */
std::vector<std::string> Roots();
/** The file name of a path. */
std::string FileName(const std::string& path);
/** The folder holding a path. */
std::string FolderOf(const std::string& path);
/** A file's bytes; empty with `error` set when it cannot be read. */
std::vector<u8> ReadFile(const std::string& path, std::string& error);
bool WriteFile(const std::string& path, const std::vector<u8>& bytes, std::string& error);

/** Projects opened recently, newest first, kept in `<folder>/recent.txt`. */
class CRecentFiles
{
public:
	/** Reads the list kept in `folder` (created when it is missing); with no folder the list is kept in memory only. */
	void Load(const std::string& folder);
	void Add(const std::string& path);
	void Remove(const std::string& path);
	const std::vector<std::string>& Paths() const { return m_Paths; }

private:
	void Save() const;

	std::string m_File;
	std::vector<std::string> m_Paths;
};

/** A PNG file of straight RGBA8 pixels, rows top first (stored, not compressed: it is written once, on request). */
std::vector<u8> EncodePng(const u8* rgba, u32 width, u32 height);

} /** namespace aep */
