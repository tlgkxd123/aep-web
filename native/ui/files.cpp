/**
 * See files.h.
 */
#include "files.h"

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <system_error>

namespace aep
{

namespace fs = std::filesystem;

namespace
{

/** Most projects the recent list keeps. */
const size_t kMaxRecent = 12;

std::string Lower(std::string s)
{
	std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return char(std::tolower(c)); });
	return s;
}

std::string PathString(const fs::path& path)
{
	return path.u8string();
}

u32 Crc32(const u8* data, size_t size, u32 crc = 0)
{
	static u32 s_Table[256];
	static bool s_bReady = false;
	if (!s_bReady)
	{
		for (u32 i = 0; i < 256; i++)
		{
			u32 c = i;
			for (s32 k = 0; k < 8; k++)
			{
				c = (c & 1) ? 0xedb88320u ^ (c >> 1) : c >> 1;
			}
			s_Table[i] = c;
		}
		s_bReady = true;
	}
	crc = ~crc;
	for (size_t i = 0; i < size; i++)
	{
		crc = s_Table[(crc ^ data[i]) & 0xff] ^ (crc >> 8);
	}
	return ~crc;
}

void PutU32(std::vector<u8>& out, u32 v)
{
	for (s32 i = 3; i >= 0; i--)
	{
		out.push_back(u8(v >> (8 * i)));
	}
}

void PutChunk(std::vector<u8>& out, const char* type, const std::vector<u8>& data)
{
	PutU32(out, u32(data.size()));
	const size_t start = out.size();
	out.insert(out.end(), type, type + 4);
	out.insert(out.end(), data.begin(), data.end());
	PutU32(out, Crc32(&out[start], out.size() - start));
}

} /** namespace */

bool ListFolder(const std::string& folder, std::vector<sFolderEntry>& out, std::string& error)
{
	out.clear();
	std::error_code ec;
	fs::directory_iterator it(fs::u8path(folder), fs::directory_options::skip_permission_denied, ec);
	if (ec)
	{
		error = ec.message();
		return false;
	}
	for (; it != fs::directory_iterator(); it.increment(ec))
	{
		if (ec)
		{
			break;
		}
		const fs::path& path = it->path();
		const std::string name = PathString(path.filename());
		if (name.empty() || name[0] == '.')
		{
			continue;
		}
		std::error_code kind;
		sFolderEntry entry;
		entry.m_Name = name;
		entry.m_Path = PathString(path);
		entry.m_bFolder = it->is_directory(kind);
		if (!entry.m_bFolder)
		{
			if (Lower(PathString(path.extension())) != ".aep")
			{
				continue;
			}
			entry.m_uBytes = u64(it->file_size(kind));
		}
		out.push_back(std::move(entry));
	}
	std::sort(out.begin(), out.end(), [](const sFolderEntry& a, const sFolderEntry& b) {
		if (a.m_bFolder != b.m_bFolder)
		{
			return a.m_bFolder;
		}
		return Lower(a.m_Name) < Lower(b.m_Name);
	});
	return true;
}

std::string ParentFolder(const std::string& folder)
{
	const fs::path path = fs::u8path(folder);
	const fs::path parent = path.has_relative_path() ? path.parent_path() : path;
	return PathString(parent.empty() ? path : parent);
}

std::string HomeFolder()
{
#if defined(_WIN32)
	const char* home = std::getenv("USERPROFILE");
#else
	const char* home = std::getenv("HOME");
#endif
	if (home && *home)
	{
		return home;
	}
	std::error_code ec;
	return PathString(fs::current_path(ec));
}

std::vector<std::string> Roots()
{
	std::vector<std::string> roots;
#if defined(_WIN32)
	for (char drive = 'A'; drive <= 'Z'; drive++)
	{
		const std::string root = std::string(1, drive) + ":\\";
		std::error_code ec;
		if (fs::exists(fs::u8path(root), ec))
		{
			roots.push_back(root);
		}
	}
#else
	roots.push_back("/");
#endif
	return roots;
}

std::string FileName(const std::string& path)
{
	return PathString(fs::u8path(path).filename());
}

std::string FolderOf(const std::string& path)
{
	return PathString(fs::u8path(path).parent_path());
}

std::vector<u8> ReadFile(const std::string& path, std::string& error)
{
	std::ifstream in(fs::u8path(path), std::ios::binary);
	if (!in)
	{
		error = "it could not be opened";
		return {};
	}
	std::vector<u8> bytes((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
	if (bytes.empty())
	{
		error = "it is empty";
	}
	return bytes;
}

bool WriteFile(const std::string& path, const std::vector<u8>& bytes, std::string& error)
{
	std::ofstream out(fs::u8path(path), std::ios::binary);
	out.write(reinterpret_cast<const char*>(bytes.data()), std::streamsize(bytes.size()));
	if (!out)
	{
		error = "it could not be written";
		return false;
	}
	return true;
}

void CRecentFiles::Load(const std::string& folder)
{
	m_Paths.clear();
	m_File.clear();
	if (folder.empty())
	{
		return;
	}
	std::error_code ec;
	fs::create_directories(fs::u8path(folder), ec);
	m_File = PathString(fs::u8path(folder) / "recent.txt");
	std::ifstream in(fs::u8path(m_File));
	std::string line;
	while (std::getline(in, line) && m_Paths.size() < kMaxRecent)
	{
		if (!line.empty() && line.back() == '\r')
		{
			line.pop_back();
		}
		if (!line.empty())
		{
			m_Paths.push_back(line);
		}
	}
}

void CRecentFiles::Add(const std::string& path)
{
	Remove(path);
	m_Paths.insert(m_Paths.begin(), path);
	if (m_Paths.size() > kMaxRecent)
	{
		m_Paths.resize(kMaxRecent);
	}
	Save();
}

void CRecentFiles::Remove(const std::string& path)
{
	m_Paths.erase(std::remove(m_Paths.begin(), m_Paths.end(), path), m_Paths.end());
	Save();
}

void CRecentFiles::Save() const
{
	if (m_File.empty())
	{
		return;
	}
	std::ofstream out(fs::u8path(m_File));
	for (const std::string& path : m_Paths)
	{
		out << path << '\n';
	}
}

std::vector<u8> EncodePng(const u8* rgba, u32 width, u32 height)
{
	std::vector<u8> png = { 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n' };
	std::vector<u8> header;
	PutU32(header, width);
	PutU32(header, height);
	header.insert(header.end(), { 8, 6, 0, 0, 0 });
	PutChunk(png, "IHDR", header);

	/** Scanlines with filter 0, in zlib stored blocks of at most 65535 bytes, with the Adler-32 at the end. */
	const size_t row = size_t(width) * 4 + 1;
	std::vector<u8> raw(row * height);
	for (u32 y = 0; y < height; y++)
	{
		raw[y * row] = 0;
		std::copy(rgba + size_t(y) * width * 4, rgba + size_t(y + 1) * width * 4, raw.begin() + std::ptrdiff_t(y * row + 1));
	}
	std::vector<u8> z = { 0x78, 0x01 };
	size_t done = 0;
	do
	{
		const size_t n = std::min<size_t>(65535, raw.size() - done);
		const bool last = done + n == raw.size();
		z.push_back(last ? 1 : 0);
		z.push_back(u8(n));
		z.push_back(u8(n >> 8));
		z.push_back(u8(~n));
		z.push_back(u8(~n >> 8));
		z.insert(z.end(), raw.begin() + std::ptrdiff_t(done), raw.begin() + std::ptrdiff_t(done + n));
		done += n;
	} while (done < raw.size());
	u32 a = 1;
	u32 b = 0;
	for (const u8 c : raw)
	{
		a = (a + c) % 65521;
		b = (b + a) % 65521;
	}
	PutU32(z, (b << 16) | a);
	PutChunk(png, "IDAT", z);
	PutChunk(png, "IEND", {});
	return png;
}

} /** namespace aep */
