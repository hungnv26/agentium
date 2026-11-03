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

#include "JSInterface_Http.h"

#include "ps/HttpClient.h"
#include "scriptinterface/FunctionWrapper.h"
#include "scriptinterface/Object.h"
#include "scriptinterface/ScriptRequest.h"

#include <string>
#include <vector>

namespace JSI_Http
{
namespace
{
CHttpClient& Client()
{
	if (!g_HttpClient)
		g_HttpClient = new CHttpClient();
	return *g_HttpClient;
}

bool HttpEnabled()
{
	return CHttpClient::IsEnabled();
}

/**
 * Engine.HttpRequestStart(url, method, body, ["Header: value", ...]) -> id (0 when refused).
 */
int HttpRequestStart(const std::string& url, const std::string& method, const std::string& body, const std::vector<std::string>& headers)
{
	return Client().Start(url, method, body, headers);
}

/**
 * Engine.HttpRequestPoll(id) -> { status: "pending"|"done"|"failed"|"unknown", httpStatus, body, error }.
 * Drives pending transfers, so call it from a tick handler.
 */
JS::Value HttpRequestPoll(const ScriptRequest& rq, int id)
{
	CHttpClient& client = Client();
	client.Poll();
	CHttpClient::Response response;
	const bool found = client.Get(id, response);
	JS::RootedValue result(rq.cx);
	Script::CreateObject(rq, &result);
	const char* status = !found ? "unknown" :
		response.status == CHttpClient::Status::DONE ? "done" :
		response.status == CHttpClient::Status::FAILED ? "failed" : "pending";
	Script::SetProperty(rq, result, "status", std::string(status));
	Script::SetProperty(rq, result, "httpStatus", static_cast<int>(response.httpStatus));
	Script::SetProperty(rq, result, "body", response.body);
	Script::SetProperty(rq, result, "error", response.error);
	// A finished request is forgotten once it has been read.
	if (found && response.status != CHttpClient::Status::PENDING)
		client.Cancel(id);
	return result;
}

void HttpRequestCancel(int id)
{
	Client().Cancel(id);
}
}

void RegisterScriptFunctions(const ScriptRequest& rq)
{
	ScriptFunction::Register<&HttpEnabled>(rq, "HttpEnabled");
	ScriptFunction::Register<&HttpRequestStart>(rq, "HttpRequestStart");
	ScriptFunction::Register<&HttpRequestPoll>(rq, "HttpRequestPoll");
	ScriptFunction::Register<&HttpRequestCancel>(rq, "HttpRequestCancel");
}
}
