/* Copyright (C) 2026 Wildfire Games.
 * This file is part of 0 A.D.
 *
 * 0 A.D. is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * 0 A.D. is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with 0 A.D.  If not, see <http://www.gnu.org/licenses/>.
 */

#ifndef INCLUDED_HTTPCLIENT
#define INCLUDED_HTTPCLIENT

#include "lib/code_annotation.h"
#include "lib/external_libraries/curl.h"

#include <map>
#include <memory>
#include <string>
#include <vector>

/**
 * Agentium: small asynchronous HTTP client for GUI scripts (the in-game advisor talks to the
 * Arena's key gateway through it). Requests are started from JS and polled every tick on the
 * main thread (curl's multi interface, like ModIo), so nothing blocks the game.
 *
 * It is off unless the config value "http.enabled" is true, and a request's URL must start
 * with one of the prefixes in "http.allowlist" (comma separated; default the local gateway).
 */
class CHttpClient
{
	NONCOPYABLE(CHttpClient);
public:
	enum class Status
	{
		PENDING,
		DONE,
		FAILED,
	};

	struct Response
	{
		Status status = Status::PENDING;
		long httpStatus = 0;
		std::string body;
		std::string error;
	};

	CHttpClient();
	~CHttpClient();

	/**
	 * Whether requests are allowed at all, and to this URL.
	 */
	static bool IsEnabled();
	static bool IsAllowed(const std::string& url);

	/**
	 * Start a request. @return its id (positive), or 0 if it could not be started.
	 * @param headers "Name: value" lines.
	 */
	int Start(const std::string& url, const std::string& method, const std::string& body, const std::vector<std::string>& headers);

	/**
	 * Drive every pending transfer a little; cheap when nothing is pending.
	 */
	void Poll();

	/**
	 * @return false if no request has that id.
	 */
	bool Get(int id, Response& out) const;

	/**
	 * Forget a request (cancelling it if still running).
	 */
	void Cancel(int id);

private:
	struct Request;
	static size_t ReceiveCallback(char* buffer, size_t size, size_t nmemb, void* userp);
	void Finish(Request& request, CURLcode result);

	CURLM* m_Multi;
	std::map<int, std::unique_ptr<Request>> m_Requests;
	int m_NextId = 1;
};

extern CHttpClient* g_HttpClient;

#endif // INCLUDED_HTTPCLIENT
