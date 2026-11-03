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

#include "precompiled.h"

#include "HttpClient.h"

#include "lib/debug.h"
#include "ps/CLogger.h"
#include "ps/ConfigDB.h"

#include <algorithm>
#include <boost/algorithm/string/classification.hpp>
#include <boost/algorithm/string/split.hpp>
#include <boost/algorithm/string/trim.hpp>
#include <cstring>

CHttpClient* g_HttpClient = nullptr;

namespace
{
constexpr size_t MAX_BODY_SIZE = 4 * 1024 * 1024;
constexpr long TIMEOUT_SECONDS = 180;
constexpr long MAX_PENDING = 8;
}

struct CHttpClient::Request
{
	CURL* curl = nullptr;
	curl_slist* headers = nullptr;
	std::string body; // the request body, kept alive for curl
	Response response;
	char errorBuffer[CURL_ERROR_SIZE] = {0};

	~Request()
	{
		if (headers)
			curl_slist_free_all(headers);
		if (curl)
			curl_easy_cleanup(curl);
	}
};

CHttpClient::CHttpClient()
{
	// Reference counted: ModIo and UserReport call it too.
	curl_global_init(CURL_GLOBAL_DEFAULT);
	m_Multi = curl_multi_init();
	ENSURE(m_Multi);
}

CHttpClient::~CHttpClient()
{
	for (auto& it : m_Requests)
		if (it.second->curl)
			curl_multi_remove_handle(m_Multi, it.second->curl);
	m_Requests.clear();
	curl_multi_cleanup(m_Multi);
	curl_global_cleanup();
}

bool CHttpClient::IsEnabled()
{
	return g_ConfigDB.Get("http.enabled", false);
}

bool CHttpClient::IsAllowed(const std::string& url)
{
	if (!IsEnabled())
		return false;
	std::vector<std::string> prefixes;
	boost::split(prefixes, g_ConfigDB.Get("http.allowlist", std::string{"http://127.0.0.1:8895/"}), boost::is_any_of(","));
	for (std::string& prefix : prefixes)
	{
		boost::trim(prefix);
		if (!prefix.empty() && url.compare(0, prefix.size(), prefix) == 0)
			return true;
	}
	return false;
}

size_t CHttpClient::ReceiveCallback(char* buffer, size_t size, size_t nmemb, void* userp)
{
	Request* request = static_cast<Request*>(userp);
	const size_t bytes = size * nmemb;
	if (request->response.body.size() + bytes > MAX_BODY_SIZE)
		return 0; // aborts the transfer with CURLE_WRITE_ERROR
	request->response.body.append(buffer, bytes);
	return bytes;
}

int CHttpClient::Start(const std::string& url, const std::string& method, const std::string& body, const std::vector<std::string>& headers)
{
	if (!IsAllowed(url))
	{
		LOGWARNING("HttpClient: request to '%s' refused (http.enabled is false or the URL is not in http.allowlist)", url.c_str());
		return 0;
	}
	long pending = 0;
	for (const auto& it : m_Requests)
		if (it.second->response.status == Status::PENDING)
			++pending;
	if (pending >= MAX_PENDING)
	{
		LOGWARNING("HttpClient: too many pending requests");
		return 0;
	}

	std::unique_ptr<Request> request = std::make_unique<Request>();
	request->curl = curl_easy_init();
	if (!request->curl)
		return 0;
	request->body = body;
	CURL* curl = request->curl;
	curl_easy_setopt(curl, CURLOPT_URL, url.c_str());
	curl_easy_setopt(curl, CURLOPT_ERRORBUFFER, request->errorBuffer);
	curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
	curl_easy_setopt(curl, CURLOPT_FOLLOWLOCATION, 0L);
	curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 1L);
	curl_easy_setopt(curl, CURLOPT_TIMEOUT, TIMEOUT_SECONDS);
	curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, ReceiveCallback);
	curl_easy_setopt(curl, CURLOPT_WRITEDATA, static_cast<void*>(request.get()));
	if (method == "POST" || method == "PUT")
	{
		curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, method.c_str());
		curl_easy_setopt(curl, CURLOPT_POSTFIELDS, request->body.c_str());
		curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(request->body.size()));
	}
	else if (method != "GET")
	{
		LOGWARNING("HttpClient: unsupported method '%s'", method.c_str());
		return 0;
	}
	std::string ua = "User-Agent: agentium ";
	ua += curl_version();
	request->headers = curl_slist_append(request->headers, ua.c_str());
	for (const std::string& header : headers)
		request->headers = curl_slist_append(request->headers, header.c_str());
	curl_easy_setopt(curl, CURLOPT_HTTPHEADER, request->headers);

	if (curl_multi_add_handle(m_Multi, curl) != CURLM_OK)
		return 0;
	const int id = m_NextId++;
	m_Requests[id] = std::move(request);
	return id;
}

void CHttpClient::Finish(Request& request, CURLcode result)
{
	curl_multi_remove_handle(m_Multi, request.curl);
	if (result == CURLE_OK)
	{
		curl_easy_getinfo(request.curl, CURLINFO_RESPONSE_CODE, &request.response.httpStatus);
		request.response.status = Status::DONE;
	}
	else
	{
		request.response.status = Status::FAILED;
		request.response.error = curl_easy_strerror(result);
		if (request.errorBuffer[0])
		{
			request.response.error += ": ";
			request.response.error += request.errorBuffer;
		}
	}
}

void CHttpClient::Poll()
{
	if (m_Requests.empty())
		return;
	int stillRunning = 0;
	if (curl_multi_perform(m_Multi, &stillRunning) != CURLM_OK)
		return;
	CURLMsg* message;
	int inQueue;
	while ((message = curl_multi_info_read(m_Multi, &inQueue)))
	{
		if (message->msg != CURLMSG_DONE)
			continue;
		for (auto& it : m_Requests)
			if (it.second->curl == message->easy_handle)
			{
				Finish(*it.second, message->data.result);
				break;
			}
	}
}

bool CHttpClient::Get(int id, Response& out) const
{
	const auto it = m_Requests.find(id);
	if (it == m_Requests.end())
		return false;
	out = it->second->response;
	return true;
}

void CHttpClient::Cancel(int id)
{
	const auto it = m_Requests.find(id);
	if (it == m_Requests.end())
		return;
	if (it->second->response.status == Status::PENDING)
		curl_multi_remove_handle(m_Multi, it->second->curl);
	m_Requests.erase(it);
}
