---
title: Maia Board v1.0.0
language_tabs:
  - shell: Shell
  - http: HTTP
  - javascript: JavaScript
  - ruby: Ruby
  - python: Python
  - php: PHP
  - java: Java
  - go: Go
toc_footers: []
includes: []
search: true
highlight_theme: darkula
headingLevel: 2

---

<!-- Generator: Widdershins v4.0.1 -->

<h1 id="maia-board">Maia Board v1.0.0</h1>

> Scroll down for code samples, example requests and responses. Select a language for code samples from the tabs above or the mobile navigation menu.

<h1 id="maia-board-default">Default</h1>

## lichess-callback

<a id="opIdlichess-callback"></a>

> Code samples

```shell
# You can also use wget
curl -X GET /auth/lichess/callback \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/problem+json'

```

```http
GET /auth/lichess/callback HTTP/1.1

Content-Type: application/json
Accept: application/problem+json

```

```javascript
const inputBody = '{
  "code": "string",
  "state": "string"
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/problem+json'
};

fetch('/auth/lichess/callback',
{
  method: 'GET',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Content-Type' => 'application/json',
  'Accept' => 'application/problem+json'
}

result = RestClient.get '/auth/lichess/callback',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Content-Type': 'application/json',
  'Accept': 'application/problem+json'
}

r = requests.get('/auth/lichess/callback', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Content-Type' => 'application/json',
    'Accept' => 'application/problem+json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('GET','/auth/lichess/callback', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/auth/lichess/callback");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("GET");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Content-Type": []string{"application/json"},
        "Accept": []string{"application/problem+json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("GET", "/auth/lichess/callback", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`GET /auth/lichess/callback`

*Lichess OAuth browser leg (302 back into the app)*

> Body parameter

```json
{
  "code": "string",
  "state": "string"
}
```

<h3 id="lichess-callback-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|code|query|string|false|none|
|state|query|string|false|none|
|body|body|[LichessCallbackBody](#schemalichesscallbackbody)|false|none|

> Example responses

> 400 Response

```json
{
  "$schema": "https://example.com/ErrorModel.json",
  "detail": "Property foo is required but is missing.",
  "errors": [
    {
      "location": "string",
      "message": "string",
      "value": null
    }
  ],
  "instance": "https://example.com/error-log/abc123",
  "status": 400,
  "title": "Bad Request",
  "type": "https://example.com/errors/example"
}
```

<h3 id="lichess-callback-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|302|[Found](https://tools.ietf.org/html/rfc7231#section-6.4.3)|Found|None|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Bad Request|[ErrorModel](#schemaerrormodel)|
|422|[Unprocessable Entity](https://tools.ietf.org/html/rfc2518#section-10.3)|Unprocessable Entity|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|
|502|[Bad Gateway](https://tools.ietf.org/html/rfc7231#section-6.6.3)|Bad Gateway|[ErrorModel](#schemaerrormodel)|
|503|[Service Unavailable](https://tools.ietf.org/html/rfc7231#section-6.6.4)|Service Unavailable|[ErrorModel](#schemaerrormodel)|

### Response Headers

|Status|Header|Type|Format|Description|
|---|---|---|---|---|
|302|Location|string||none|
|302|Set-Cookie|string||none|

<aside class="success">
This operation does not require authentication
</aside>

## lichess-callback-post

<a id="opIdlichess-callback-post"></a>

> Code samples

```shell
# You can also use wget
curl -X POST /auth/lichess/callback \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json'

```

```http
POST /auth/lichess/callback HTTP/1.1

Content-Type: application/json
Accept: application/json

```

```javascript
const inputBody = '{
  "code": "string",
  "state": "string"
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json'
};

fetch('/auth/lichess/callback',
{
  method: 'POST',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Content-Type' => 'application/json',
  'Accept' => 'application/json'
}

result = RestClient.post '/auth/lichess/callback',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Content-Type': 'application/json',
  'Accept': 'application/json'
}

r = requests.post('/auth/lichess/callback', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Content-Type' => 'application/json',
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('POST','/auth/lichess/callback', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/auth/lichess/callback");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("POST");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Content-Type": []string{"application/json"},
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("POST", "/auth/lichess/callback", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`POST /auth/lichess/callback`

*Lichess OAuth code exchange (JSON leg)*

> Body parameter

```json
{
  "code": "string",
  "state": "string"
}
```

<h3 id="lichess-callback-post-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|code|query|string|false|none|
|state|query|string|false|none|
|body|body|[LichessCallbackBody](#schemalichesscallbackbody)|false|none|

> Example responses

> 200 Response

```json
{
  "$schema": "https://example.com/User.json",
  "created_at": "string",
  "display_name": "string",
  "id": "string",
  "lichess_id": "string",
  "lichess_username": "string"
}
```

<h3 id="lichess-callback-post-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|OK|[User](#schemauser)|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Bad Request|[ErrorModel](#schemaerrormodel)|
|422|[Unprocessable Entity](https://tools.ietf.org/html/rfc2518#section-10.3)|Unprocessable Entity|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|
|502|[Bad Gateway](https://tools.ietf.org/html/rfc7231#section-6.6.3)|Bad Gateway|[ErrorModel](#schemaerrormodel)|
|503|[Service Unavailable](https://tools.ietf.org/html/rfc7231#section-6.6.4)|Service Unavailable|[ErrorModel](#schemaerrormodel)|

### Response Headers

|Status|Header|Type|Format|Description|
|---|---|---|---|---|
|200|Set-Cookie|string||none|

<aside class="success">
This operation does not require authentication
</aside>

## lichess-start

<a id="opIdlichess-start"></a>

> Code samples

```shell
# You can also use wget
curl -X GET /auth/lichess/start \
  -H 'Accept: application/json'

```

```http
GET /auth/lichess/start HTTP/1.1

Accept: application/json

```

```javascript

const headers = {
  'Accept':'application/json'
};

fetch('/auth/lichess/start',
{
  method: 'GET',

  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Accept' => 'application/json'
}

result = RestClient.get '/auth/lichess/start',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Accept': 'application/json'
}

r = requests.get('/auth/lichess/start', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('GET','/auth/lichess/start', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/auth/lichess/start");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("GET");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("GET", "/auth/lichess/start", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`GET /auth/lichess/start`

*Begin Lichess OAuth (PKCE S256, scope preference:read)*

<h3 id="lichess-start-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|redirect_uri|query|string|false|none|

> Example responses

> 200 Response

```json
{
  "$schema": "https://example.com/LichessStartBody.json",
  "authorization_url": "string",
  "state": "string"
}
```

<h3 id="lichess-start-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|OK|[LichessStartBody](#schemalichessstartbody)|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Bad Request|[ErrorModel](#schemaerrormodel)|
|422|[Unprocessable Entity](https://tools.ietf.org/html/rfc2518#section-10.3)|Unprocessable Entity|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|
|501|[Not Implemented](https://tools.ietf.org/html/rfc7231#section-6.6.2)|Not Implemented|[ErrorModel](#schemaerrormodel)|
|502|[Bad Gateway](https://tools.ietf.org/html/rfc7231#section-6.6.3)|Bad Gateway|[ErrorModel](#schemaerrormodel)|
|503|[Service Unavailable](https://tools.ietf.org/html/rfc7231#section-6.6.4)|Service Unavailable|[ErrorModel](#schemaerrormodel)|

<aside class="success">
This operation does not require authentication
</aside>

## lichess-start-post

<a id="opIdlichess-start-post"></a>

> Code samples

```shell
# You can also use wget
curl -X POST /auth/lichess/start \
  -H 'Accept: application/json'

```

```http
POST /auth/lichess/start HTTP/1.1

Accept: application/json

```

```javascript

const headers = {
  'Accept':'application/json'
};

fetch('/auth/lichess/start',
{
  method: 'POST',

  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Accept' => 'application/json'
}

result = RestClient.post '/auth/lichess/start',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Accept': 'application/json'
}

r = requests.post('/auth/lichess/start', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('POST','/auth/lichess/start', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/auth/lichess/start");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("POST");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("POST", "/auth/lichess/start", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`POST /auth/lichess/start`

*Begin Lichess OAuth (JSON leg)*

<h3 id="lichess-start-post-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|redirect_uri|query|string|false|none|

> Example responses

> 200 Response

```json
{
  "$schema": "https://example.com/LichessStartBody.json",
  "authorization_url": "string",
  "state": "string"
}
```

<h3 id="lichess-start-post-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|OK|[LichessStartBody](#schemalichessstartbody)|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Bad Request|[ErrorModel](#schemaerrormodel)|
|422|[Unprocessable Entity](https://tools.ietf.org/html/rfc2518#section-10.3)|Unprocessable Entity|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|
|501|[Not Implemented](https://tools.ietf.org/html/rfc7231#section-6.6.2)|Not Implemented|[ErrorModel](#schemaerrormodel)|
|502|[Bad Gateway](https://tools.ietf.org/html/rfc7231#section-6.6.3)|Bad Gateway|[ErrorModel](#schemaerrormodel)|
|503|[Service Unavailable](https://tools.ietf.org/html/rfc7231#section-6.6.4)|Service Unavailable|[ErrorModel](#schemaerrormodel)|

<aside class="success">
This operation does not require authentication
</aside>

## auth-local

<a id="opIdauth-local"></a>

> Code samples

```shell
# You can also use wget
curl -X POST /auth/local \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json'

```

```http
POST /auth/local HTTP/1.1

Content-Type: application/json
Accept: application/json

```

```javascript
const inputBody = '{
  "display_name": "string"
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json'
};

fetch('/auth/local',
{
  method: 'POST',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Content-Type' => 'application/json',
  'Accept' => 'application/json'
}

result = RestClient.post '/auth/local',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Content-Type': 'application/json',
  'Accept': 'application/json'
}

r = requests.post('/auth/local', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Content-Type' => 'application/json',
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('POST','/auth/local', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/auth/local");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("POST");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Content-Type": []string{"application/json"},
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("POST", "/auth/local", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`POST /auth/local`

*Create a local session account*

> Body parameter

```json
{
  "display_name": "string"
}
```

<h3 id="auth-local-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|body|body|[LoginInputBody](#schemalogininputbody)|false|none|

> Example responses

> 200 Response

```json
{
  "$schema": "https://example.com/User.json",
  "created_at": "string",
  "display_name": "string",
  "id": "string",
  "lichess_id": "string",
  "lichess_username": "string"
}
```

<h3 id="auth-local-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|OK|[User](#schemauser)|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Bad Request|[ErrorModel](#schemaerrormodel)|
|422|[Unprocessable Entity](https://tools.ietf.org/html/rfc2518#section-10.3)|Unprocessable Entity|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|
|502|[Bad Gateway](https://tools.ietf.org/html/rfc7231#section-6.6.3)|Bad Gateway|[ErrorModel](#schemaerrormodel)|
|503|[Service Unavailable](https://tools.ietf.org/html/rfc7231#section-6.6.4)|Service Unavailable|[ErrorModel](#schemaerrormodel)|

### Response Headers

|Status|Header|Type|Format|Description|
|---|---|---|---|---|
|200|Set-Cookie|string||none|

<aside class="success">
This operation does not require authentication
</aside>

## auth-logout

<a id="opIdauth-logout"></a>

> Code samples

```shell
# You can also use wget
curl -X POST /auth/logout \
  -H 'Accept: application/problem+json'

```

```http
POST /auth/logout HTTP/1.1

Accept: application/problem+json

```

```javascript

const headers = {
  'Accept':'application/problem+json'
};

fetch('/auth/logout',
{
  method: 'POST',

  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Accept' => 'application/problem+json'
}

result = RestClient.post '/auth/logout',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Accept': 'application/problem+json'
}

r = requests.post('/auth/logout', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Accept' => 'application/problem+json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('POST','/auth/logout', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/auth/logout");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("POST");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Accept": []string{"application/problem+json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("POST", "/auth/logout", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`POST /auth/logout`

*Revoke the session*

> Example responses

> default Response

```json
{
  "$schema": "https://example.com/ErrorModel.json",
  "detail": "Property foo is required but is missing.",
  "errors": [
    {
      "location": "string",
      "message": "string",
      "value": null
    }
  ],
  "instance": "https://example.com/error-log/abc123",
  "status": 400,
  "title": "Bad Request",
  "type": "https://example.com/errors/example"
}
```

<h3 id="auth-logout-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|204|[No Content](https://tools.ietf.org/html/rfc7231#section-6.3.5)|No Content|None|
|default|Default|Error|[ErrorModel](#schemaerrormodel)|

### Response Headers

|Status|Header|Type|Format|Description|
|---|---|---|---|---|
|204|Set-Cookie|string||none|

<aside class="success">
This operation does not require authentication
</aside>

## evaluate

<a id="opIdevaluate"></a>

> Code samples

```shell
# You can also use wget
curl -X POST /evaluate \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json'

```

```http
POST /evaluate HTTP/1.1

Content-Type: application/json
Accept: application/json

```

```javascript
const inputBody = '{
  "fen": "string",
  "initial_fen": "string",
  "moves": [
    "string"
  ],
  "settings": {
    "depth": 0,
    "lines": 0,
    "time_ms": 0
  }
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json'
};

fetch('/evaluate',
{
  method: 'POST',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Content-Type' => 'application/json',
  'Accept' => 'application/json'
}

result = RestClient.post '/evaluate',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Content-Type': 'application/json',
  'Accept': 'application/json'
}

r = requests.post('/evaluate', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Content-Type' => 'application/json',
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('POST','/evaluate', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/evaluate");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("POST");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Content-Type": []string{"application/json"},
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("POST", "/evaluate", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`POST /evaluate`

*Stockfish search (Focus lane)*

> Body parameter

```json
{
  "fen": "string",
  "initial_fen": "string",
  "moves": [
    "string"
  ],
  "settings": {
    "depth": 0,
    "lines": 0,
    "time_ms": 0
  }
}
```

<h3 id="evaluate-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|body|body|[EvaluationRequest](#schemaevaluationrequest)|true|none|

> Example responses

> 200 Response

```json
{
  "$schema": "https://example.com/EvaluationResponse.json",
  "actual_settings": {
    "depth": 0,
    "lines": 0,
    "time_ms": 0
  },
  "best_move": "string",
  "depth": 0,
  "engine": "string",
  "lines": [
    {
      "depth": 0,
      "move": "string",
      "pv": [
        "string"
      ],
      "score": {
        "type": "string",
        "value": 0,
        "winning_side": "string"
      }
    }
  ],
  "score": {
    "type": "string",
    "value": 0,
    "winning_side": "string"
  },
  "search_policy": "string",
  "terminal": "string"
}
```

<h3 id="evaluate-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|OK|[EvaluationResponse](#schemaevaluationresponse)|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Bad Request|[ErrorModel](#schemaerrormodel)|
|422|[Unprocessable Entity](https://tools.ietf.org/html/rfc2518#section-10.3)|Unprocessable Entity|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|
|502|[Bad Gateway](https://tools.ietf.org/html/rfc7231#section-6.6.3)|Bad Gateway|[ErrorModel](#schemaerrormodel)|
|503|[Service Unavailable](https://tools.ietf.org/html/rfc7231#section-6.6.4)|Service Unavailable|[ErrorModel](#schemaerrormodel)|

### Response Headers

|Status|Header|Type|Format|Description|
|---|---|---|---|---|
|200|X-Eval-Cache|string||none|

<aside class="success">
This operation does not require authentication
</aside>

## evaluations-lookup

<a id="opIdevaluations-lookup"></a>

> Code samples

```shell
# You can also use wget
curl -X POST /evaluations/lookup \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json'

```

```http
POST /evaluations/lookup HTTP/1.1

Content-Type: application/json
Accept: application/json

```

```javascript
const inputBody = '{
  "line": {
    "initial_fen": "string",
    "moves": [
      "string"
    ]
  },
  "requests": [
    {
      "elo_maia": 0,
      "elo_user": 0,
      "engine": "string",
      "fen": "string",
      "model": "string",
      "ply": 0,
      "settings": {
        "depth": 0,
        "lines": 0,
        "time_ms": 0
      },
      "value_elo_maia": 0,
      "value_elo_user": 0
    }
  ]
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json'
};

fetch('/evaluations/lookup',
{
  method: 'POST',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Content-Type' => 'application/json',
  'Accept' => 'application/json'
}

result = RestClient.post '/evaluations/lookup',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Content-Type': 'application/json',
  'Accept': 'application/json'
}

r = requests.post('/evaluations/lookup', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Content-Type' => 'application/json',
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('POST','/evaluations/lookup', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/evaluations/lookup");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("POST");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Content-Type": []string{"application/json"},
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("POST", "/evaluations/lookup", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`POST /evaluations/lookup`

*Bulk cache read (read-only, never admits or infers)*

> Body parameter

```json
{
  "line": {
    "initial_fen": "string",
    "moves": [
      "string"
    ]
  },
  "requests": [
    {
      "elo_maia": 0,
      "elo_user": 0,
      "engine": "string",
      "fen": "string",
      "model": "string",
      "ply": 0,
      "settings": {
        "depth": 0,
        "lines": 0,
        "time_ms": 0
      },
      "value_elo_maia": 0,
      "value_elo_user": 0
    }
  ]
}
```

<h3 id="evaluations-lookup-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|body|body|[LookupBody](#schemalookupbody)|true|none|

> Example responses

> 200 Response

```json
{
  "$schema": "https://example.com/LookupResults.json",
  "results": [
    {
      "actual_settings": {
        "depth": 0,
        "lines": 0,
        "time_ms": 0
      },
      "index": 0,
      "value": null
    }
  ]
}
```

<h3 id="evaluations-lookup-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|OK|[LookupResults](#schemalookupresults)|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Bad Request|[ErrorModel](#schemaerrormodel)|
|422|[Unprocessable Entity](https://tools.ietf.org/html/rfc2518#section-10.3)|Unprocessable Entity|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|

<aside class="success">
This operation does not require authentication
</aside>

## games-list

<a id="opIdgames-list"></a>

> Code samples

```shell
# You can also use wget
curl -X GET /games \
  -H 'Accept: application/json'

```

```http
GET /games HTTP/1.1

Accept: application/json

```

```javascript

const headers = {
  'Accept':'application/json'
};

fetch('/games',
{
  method: 'GET',

  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Accept' => 'application/json'
}

result = RestClient.get '/games',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Accept': 'application/json'
}

r = requests.get('/games', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('GET','/games', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/games");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("GET");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("GET", "/games", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`GET /games`

*List saved games with paging*

<h3 id="games-list-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|limit|query|string|false|none|
|offset|query|string|false|none|

> Example responses

> 200 Response

```json
{
  "$schema": "https://example.com/GamesPage.json",
  "current_game": {
    "$schema": "https://example.com/GameRow.json",
    "clocks": [
      0
    ],
    "created_at": "string",
    "elo_maia": 0,
    "elo_user": 0,
    "id": "string",
    "model": "string",
    "moves": [
      "string"
    ],
    "opponent": "string",
    "owner_id": "string",
    "rating_diff": 0,
    "result": "string",
    "source": "string",
    "speed": "string",
    "temperature": 0.1,
    "time_control": "string",
    "updated_at": "string",
    "user_color": "string"
  },
  "current_id": "string",
  "games": [
    {
      "$schema": "https://example.com/GameRow.json",
      "clocks": [
        0
      ],
      "created_at": "string",
      "elo_maia": 0,
      "elo_user": 0,
      "id": "string",
      "model": "string",
      "moves": [
        "string"
      ],
      "opponent": "string",
      "owner_id": "string",
      "rating_diff": 0,
      "result": "string",
      "source": "string",
      "speed": "string",
      "temperature": 0.1,
      "time_control": "string",
      "updated_at": "string",
      "user_color": "string"
    }
  ],
  "next_offset": 0,
  "total": 0
}
```

<h3 id="games-list-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|OK|[GamesPage](#schemagamespage)|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Bad Request|[ErrorModel](#schemaerrormodel)|
|422|[Unprocessable Entity](https://tools.ietf.org/html/rfc2518#section-10.3)|Unprocessable Entity|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|
|502|[Bad Gateway](https://tools.ietf.org/html/rfc7231#section-6.6.3)|Bad Gateway|[ErrorModel](#schemaerrormodel)|

<aside class="success">
This operation does not require authentication
</aside>

## games-create

<a id="opIdgames-create"></a>

> Code samples

```shell
# You can also use wget
curl -X POST /games \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json'

```

```http
POST /games HTTP/1.1

Content-Type: application/json
Accept: application/json

```

```javascript
const inputBody = '{
  "clocks": [
    0
  ],
  "created_at": "string",
  "current": true,
  "elo_maia": 0,
  "elo_user": 0,
  "id": "string",
  "model": "string",
  "moves": [
    "string"
  ],
  "opponent": "string",
  "owner_id": "string",
  "rating_diff": 0,
  "result": "string",
  "source": "string",
  "speed": "string",
  "temperature": 0.1,
  "time_control": "string",
  "user_color": "string"
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json'
};

fetch('/games',
{
  method: 'POST',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Content-Type' => 'application/json',
  'Accept' => 'application/json'
}

result = RestClient.post '/games',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Content-Type': 'application/json',
  'Accept': 'application/json'
}

r = requests.post('/games', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Content-Type' => 'application/json',
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('POST','/games', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/games");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("POST");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Content-Type": []string{"application/json"},
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("POST", "/games", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`POST /games`

*Save a game (upsert by id)*

> Body parameter

```json
{
  "clocks": [
    0
  ],
  "created_at": "string",
  "current": true,
  "elo_maia": 0,
  "elo_user": 0,
  "id": "string",
  "model": "string",
  "moves": [
    "string"
  ],
  "opponent": "string",
  "owner_id": "string",
  "rating_diff": 0,
  "result": "string",
  "source": "string",
  "speed": "string",
  "temperature": 0.1,
  "time_control": "string",
  "user_color": "string"
}
```

<h3 id="games-create-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|body|body|[GamePayload](#schemagamepayload)|true|none|

> Example responses

> 200 Response

```json
{
  "$schema": "https://example.com/GameRow.json",
  "clocks": [
    0
  ],
  "created_at": "string",
  "elo_maia": 0,
  "elo_user": 0,
  "id": "string",
  "model": "string",
  "moves": [
    "string"
  ],
  "opponent": "string",
  "owner_id": "string",
  "rating_diff": 0,
  "result": "string",
  "source": "string",
  "speed": "string",
  "temperature": 0.1,
  "time_control": "string",
  "updated_at": "string",
  "user_color": "string"
}
```

<h3 id="games-create-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|OK|[GameRow](#schemagamerow)|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Bad Request|[ErrorModel](#schemaerrormodel)|
|422|[Unprocessable Entity](https://tools.ietf.org/html/rfc2518#section-10.3)|Unprocessable Entity|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|
|502|[Bad Gateway](https://tools.ietf.org/html/rfc7231#section-6.6.3)|Bad Gateway|[ErrorModel](#schemaerrormodel)|

<aside class="success">
This operation does not require authentication
</aside>

## games-delete

<a id="opIdgames-delete"></a>

> Code samples

```shell
# You can also use wget
curl -X DELETE /games/{id} \
  -H 'Accept: application/problem+json'

```

```http
DELETE /games/{id} HTTP/1.1

Accept: application/problem+json

```

```javascript

const headers = {
  'Accept':'application/problem+json'
};

fetch('/games/{id}',
{
  method: 'DELETE',

  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Accept' => 'application/problem+json'
}

result = RestClient.delete '/games/{id}',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Accept': 'application/problem+json'
}

r = requests.delete('/games/{id}', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Accept' => 'application/problem+json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('DELETE','/games/{id}', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/games/{id}");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("DELETE");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Accept": []string{"application/problem+json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("DELETE", "/games/{id}", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`DELETE /games/{id}`

*Delete one saved game*

<h3 id="games-delete-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|id|path|string|true|none|

> Example responses

> 422 Response

```json
{
  "$schema": "https://example.com/ErrorModel.json",
  "detail": "Property foo is required but is missing.",
  "errors": [
    {
      "location": "string",
      "message": "string",
      "value": null
    }
  ],
  "instance": "https://example.com/error-log/abc123",
  "status": 400,
  "title": "Bad Request",
  "type": "https://example.com/errors/example"
}
```

<h3 id="games-delete-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|204|[No Content](https://tools.ietf.org/html/rfc7231#section-6.3.5)|No Content|None|
|422|[Unprocessable Entity](https://tools.ietf.org/html/rfc2518#section-10.3)|Unprocessable Entity|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|
|502|[Bad Gateway](https://tools.ietf.org/html/rfc7231#section-6.6.3)|Bad Gateway|[ErrorModel](#schemaerrormodel)|

<aside class="success">
This operation does not require authentication
</aside>

## games-get

<a id="opIdgames-get"></a>

> Code samples

```shell
# You can also use wget
curl -X GET /games/{id} \
  -H 'Accept: application/json'

```

```http
GET /games/{id} HTTP/1.1

Accept: application/json

```

```javascript

const headers = {
  'Accept':'application/json'
};

fetch('/games/{id}',
{
  method: 'GET',

  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Accept' => 'application/json'
}

result = RestClient.get '/games/{id}',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Accept': 'application/json'
}

r = requests.get('/games/{id}', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('GET','/games/{id}', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/games/{id}");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("GET");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("GET", "/games/{id}", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`GET /games/{id}`

*Fetch one saved game*

<h3 id="games-get-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|id|path|string|true|none|

> Example responses

> 200 Response

```json
{
  "$schema": "https://example.com/GameRow.json",
  "clocks": [
    0
  ],
  "created_at": "string",
  "elo_maia": 0,
  "elo_user": 0,
  "id": "string",
  "model": "string",
  "moves": [
    "string"
  ],
  "opponent": "string",
  "owner_id": "string",
  "rating_diff": 0,
  "result": "string",
  "source": "string",
  "speed": "string",
  "temperature": 0.1,
  "time_control": "string",
  "updated_at": "string",
  "user_color": "string"
}
```

<h3 id="games-get-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|OK|[GameRow](#schemagamerow)|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Not Found|[ErrorModel](#schemaerrormodel)|
|422|[Unprocessable Entity](https://tools.ietf.org/html/rfc2518#section-10.3)|Unprocessable Entity|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|
|502|[Bad Gateway](https://tools.ietf.org/html/rfc7231#section-6.6.3)|Bad Gateway|[ErrorModel](#schemaerrormodel)|

<aside class="success">
This operation does not require authentication
</aside>

## healthz

<a id="opIdhealthz"></a>

> Code samples

```shell
# You can also use wget
curl -X GET /healthz \
  -H 'Accept: application/json'

```

```http
GET /healthz HTTP/1.1

Accept: application/json

```

```javascript

const headers = {
  'Accept':'application/json'
};

fetch('/healthz',
{
  method: 'GET',

  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Accept' => 'application/json'
}

result = RestClient.get '/healthz',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Accept': 'application/json'
}

r = requests.get('/healthz', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('GET','/healthz', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/healthz");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("GET");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("GET", "/healthz", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`GET /healthz`

*Engine pool health*

> Example responses

> 200 Response

```json
{
  "$schema": "https://example.com/HealthBody.json",
  "models": {
    "property1": {
      "last_error": "string",
      "state": "string"
    },
    "property2": {
      "last_error": "string",
      "state": "string"
    }
  },
  "status": "string"
}
```

<h3 id="healthz-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|OK|[HealthBody](#schemahealthbody)|
|default|Default|Error|[ErrorModel](#schemaerrormodel)|

<aside class="success">
This operation does not require authentication
</aside>

## imports-games

<a id="opIdimports-games"></a>

> Code samples

```shell
# You can also use wget
curl -X POST /imports/games \
  -H 'Accept: application/json'

```

```http
POST /imports/games HTTP/1.1

Accept: application/json

```

```javascript

const headers = {
  'Accept':'application/json'
};

fetch('/imports/games',
{
  method: 'POST',

  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Accept' => 'application/json'
}

result = RestClient.post '/imports/games',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Accept': 'application/json'
}

r = requests.post('/imports/games', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('POST','/imports/games', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/imports/games");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("POST");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("POST", "/imports/games", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`POST /imports/games`

*Bulk Lichess history append (max 100 entries, 4 MiB)*

> Example responses

<h3 id="imports-games-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|200 even when all rows skip (already up to date); 400 when nothing saved and real errors exist|None|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|invalid_request (empty or >100 entries, unknown provider), invalid_source, invalid_opponent, invalid_rating_diff, per-index codes in errors map|None|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Unauthenticated|None|

<h3 id="imports-games-responseschema">Response Schema</h3>

<aside class="success">
This operation does not require authentication
</aside>

## imports-status

<a id="opIdimports-status"></a>

> Code samples

```shell
# You can also use wget
curl -X GET /imports/status \
  -H 'Accept: application/json'

```

```http
GET /imports/status HTTP/1.1

Accept: application/json

```

```javascript

const headers = {
  'Accept':'application/json'
};

fetch('/imports/status',
{
  method: 'GET',

  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Accept' => 'application/json'
}

result = RestClient.get '/imports/status',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Accept': 'application/json'
}

r = requests.get('/imports/status', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('GET','/imports/status', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/imports/status");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("GET");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("GET", "/imports/status", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`GET /imports/status`

*Newest Lichess import run plus owned total*

> Example responses

> 200 Response

```json
{
  "$schema": "https://example.com/ImportStatusBody.json",
  "last": {
    "created_at": "string",
    "id": "string",
    "provider": "string",
    "requested": 0,
    "saved": 0,
    "skipped": 0,
    "user_id": "string",
    "username": "string"
  },
  "total": 0
}
```

<h3 id="imports-status-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|OK|[ImportStatusBody](#schemaimportstatusbody)|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Unauthorized|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|
|502|[Bad Gateway](https://tools.ietf.org/html/rfc7231#section-6.6.3)|Bad Gateway|[ErrorModel](#schemaerrormodel)|

<aside class="success">
This operation does not require authentication
</aside>

## me

<a id="opIdme"></a>

> Code samples

```shell
# You can also use wget
curl -X GET /me \
  -H 'Accept: application/json'

```

```http
GET /me HTTP/1.1

Accept: application/json

```

```javascript

const headers = {
  'Accept':'application/json'
};

fetch('/me',
{
  method: 'GET',

  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Accept' => 'application/json'
}

result = RestClient.get '/me',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Accept': 'application/json'
}

r = requests.get('/me', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('GET','/me', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/me");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("GET");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("GET", "/me", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`GET /me`

*Current session user*

> Example responses

> 200 Response

```json
{
  "$schema": "https://example.com/User.json",
  "created_at": "string",
  "display_name": "string",
  "id": "string",
  "lichess_id": "string",
  "lichess_username": "string"
}
```

<h3 id="me-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|OK|[User](#schemauser)|
|401|[Unauthorized](https://tools.ietf.org/html/rfc7235#section-3.1)|Unauthorized|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|
|503|[Service Unavailable](https://tools.ietf.org/html/rfc7231#section-6.6.4)|Service Unavailable|[ErrorModel](#schemaerrormodel)|

<aside class="success">
This operation does not require authentication
</aside>

## move

<a id="opIdmove"></a>

> Code samples

```shell
# You can also use wget
curl -X POST /move \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json'

```

```http
POST /move HTTP/1.1

Content-Type: application/json
Accept: application/json

```

```javascript
const inputBody = '{
  "elo_maia": 0,
  "elo_user": 0,
  "fen": "string",
  "initial_fen": "string",
  "maia_color": "string",
  "model": "string",
  "moves": [
    "string"
  ],
  "temperature": 0.1,
  "value_elo_maia": 0,
  "value_elo_user": 0
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json'
};

fetch('/move',
{
  method: 'POST',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Content-Type' => 'application/json',
  'Accept' => 'application/json'
}

result = RestClient.post '/move',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Content-Type': 'application/json',
  'Accept': 'application/json'
}

r = requests.post('/move', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Content-Type' => 'application/json',
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('POST','/move', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/move");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("POST");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Content-Type": []string{"application/json"},
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("POST", "/move", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`POST /move`

*Live Maia game reply (Play lane)*

> Body parameter

```json
{
  "elo_maia": 0,
  "elo_user": 0,
  "fen": "string",
  "initial_fen": "string",
  "maia_color": "string",
  "model": "string",
  "moves": [
    "string"
  ],
  "temperature": 0.1,
  "value_elo_maia": 0,
  "value_elo_user": 0
}
```

<h3 id="move-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|body|body|[MoveRequest](#schemamoverequest)|true|none|

> Example responses

> 200 Response

```json
{
  "$schema": "https://example.com/MoveResponse.json",
  "degraded": true,
  "delta_baseline": {
    "kind": "string",
    "value": 0.1
  },
  "model_used": "string",
  "move": "string",
  "top_moves": [
    {
      "delta": 0.1,
      "move": "string",
      "prob": 0.1,
      "wdl": [
        0.1,
        0.1,
        0.1
      ]
    }
  ],
  "wdl": [
    0.1,
    0.1,
    0.1
  ]
}
```

<h3 id="move-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|OK|[MoveResponse](#schemamoveresponse)|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Bad Request|[ErrorModel](#schemaerrormodel)|
|409|[Conflict](https://tools.ietf.org/html/rfc7231#section-6.5.8)|Conflict|[ErrorModel](#schemaerrormodel)|
|422|[Unprocessable Entity](https://tools.ietf.org/html/rfc2518#section-10.3)|Unprocessable Entity|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|
|502|[Bad Gateway](https://tools.ietf.org/html/rfc7231#section-6.6.3)|Bad Gateway|[ErrorModel](#schemaerrormodel)|
|503|[Service Unavailable](https://tools.ietf.org/html/rfc7231#section-6.6.4)|Service Unavailable|[ErrorModel](#schemaerrormodel)|

### Response Headers

|Status|Header|Type|Format|Description|
|---|---|---|---|---|
|200|X-Eval-Cache|string||none|

<aside class="success">
This operation does not require authentication
</aside>

## move-analysis

<a id="opIdmove-analysis"></a>

> Code samples

```shell
# You can also use wget
curl -X POST /move/analysis \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json'

```

```http
POST /move/analysis HTTP/1.1

Content-Type: application/json
Accept: application/json

```

```javascript
const inputBody = '{
  "elo_maia": 0,
  "elo_user": 0,
  "fen": "string",
  "initial_fen": "string",
  "maia_color": "string",
  "model": "string",
  "moves": [
    "string"
  ],
  "temperature": 0.1,
  "value_elo_maia": 0,
  "value_elo_user": 0
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json'
};

fetch('/move/analysis',
{
  method: 'POST',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Content-Type' => 'application/json',
  'Accept' => 'application/json'
}

result = RestClient.post '/move/analysis',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Content-Type': 'application/json',
  'Accept': 'application/json'
}

r = requests.post('/move/analysis', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Content-Type' => 'application/json',
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('POST','/move/analysis', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/move/analysis");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("POST");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Content-Type": []string{"application/json"},
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("POST", "/move/analysis", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`POST /move/analysis`

*Retrospective Maia analysis (Focus lane)*

> Body parameter

```json
{
  "elo_maia": 0,
  "elo_user": 0,
  "fen": "string",
  "initial_fen": "string",
  "maia_color": "string",
  "model": "string",
  "moves": [
    "string"
  ],
  "temperature": 0.1,
  "value_elo_maia": 0,
  "value_elo_user": 0
}
```

<h3 id="move-analysis-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|body|body|[MoveRequest](#schemamoverequest)|true|none|

> Example responses

> 200 Response

```json
{
  "$schema": "https://example.com/MoveResponse.json",
  "degraded": true,
  "delta_baseline": {
    "kind": "string",
    "value": 0.1
  },
  "model_used": "string",
  "move": "string",
  "top_moves": [
    {
      "delta": 0.1,
      "move": "string",
      "prob": 0.1,
      "wdl": [
        0.1,
        0.1,
        0.1
      ]
    }
  ],
  "wdl": [
    0.1,
    0.1,
    0.1
  ]
}
```

<h3 id="move-analysis-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|OK|[MoveResponse](#schemamoveresponse)|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Bad Request|[ErrorModel](#schemaerrormodel)|
|409|[Conflict](https://tools.ietf.org/html/rfc7231#section-6.5.8)|Conflict|[ErrorModel](#schemaerrormodel)|
|422|[Unprocessable Entity](https://tools.ietf.org/html/rfc2518#section-10.3)|Unprocessable Entity|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|
|502|[Bad Gateway](https://tools.ietf.org/html/rfc7231#section-6.6.3)|Bad Gateway|[ErrorModel](#schemaerrormodel)|
|503|[Service Unavailable](https://tools.ietf.org/html/rfc7231#section-6.6.4)|Service Unavailable|[ErrorModel](#schemaerrormodel)|

### Response Headers

|Status|Header|Type|Format|Description|
|---|---|---|---|---|
|200|X-Eval-Cache|string||none|

<aside class="success">
This operation does not require authentication
</aside>

## openings

<a id="opIdopenings"></a>

> Code samples

```shell
# You can also use wget
curl -X POST /openings \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json'

```

```http
POST /openings HTTP/1.1

Content-Type: application/json
Accept: application/json

```

```javascript
const inputBody = '{
  "initial_fen": "string",
  "moves": [
    "string"
  ]
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json'
};

fetch('/openings',
{
  method: 'POST',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Content-Type' => 'application/json',
  'Accept' => 'application/json'
}

result = RestClient.post '/openings',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Content-Type': 'application/json',
  'Accept': 'application/json'
}

r = requests.post('/openings', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Content-Type' => 'application/json',
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('POST','/openings', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/openings");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("POST");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Content-Type": []string{"application/json"},
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("POST", "/openings", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`POST /openings`

*ECO opening names for a move line*

> Body parameter

```json
{
  "initial_fen": "string",
  "moves": [
    "string"
  ]
}
```

<h3 id="openings-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|body|body|[Request](#schemarequest)|true|none|

> Example responses

> 200 Response

```json
{
  "$schema": "https://example.com/Response.json",
  "book_flags": [
    true
  ],
  "degraded": true,
  "matches": [
    {
      "eco": "string",
      "name": "string",
      "ply": 0
    }
  ]
}
```

<h3 id="openings-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|OK|[Response](#schemaresponse)|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Bad Request|[ErrorModel](#schemaerrormodel)|
|422|[Unprocessable Entity](https://tools.ietf.org/html/rfc2518#section-10.3)|Unprocessable Entity|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|
|502|[Bad Gateway](https://tools.ietf.org/html/rfc7231#section-6.6.3)|Bad Gateway|[ErrorModel](#schemaerrormodel)|

<aside class="success">
This operation does not require authentication
</aside>

## reviews-submit

<a id="opIdreviews-submit"></a>

> Code samples

```shell
# You can also use wget
curl -X POST /reviews \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json'

```

```http
POST /reviews HTTP/1.1

Content-Type: application/json
Accept: application/json

```

```javascript
const inputBody = '{
  "line": {
    "initial_fen": "string",
    "moves": [
      "string"
    ]
  },
  "requests": [
    {
      "elo_maia": 0,
      "elo_user": 0,
      "engine": "string",
      "fen": "string",
      "model": "string",
      "ply": 0,
      "settings": {
        "depth": 0,
        "lines": 0,
        "time_ms": 0
      },
      "value_elo_maia": 0,
      "value_elo_user": 0
    }
  ]
}';
const headers = {
  'Content-Type':'application/json',
  'Accept':'application/json'
};

fetch('/reviews',
{
  method: 'POST',
  body: inputBody,
  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Content-Type' => 'application/json',
  'Accept' => 'application/json'
}

result = RestClient.post '/reviews',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Content-Type': 'application/json',
  'Accept': 'application/json'
}

r = requests.post('/reviews', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Content-Type' => 'application/json',
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('POST','/reviews', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/reviews");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("POST");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Content-Type": []string{"application/json"},
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("POST", "/reviews", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`POST /reviews`

*Submit a whole-game batch review*

> Body parameter

```json
{
  "line": {
    "initial_fen": "string",
    "moves": [
      "string"
    ]
  },
  "requests": [
    {
      "elo_maia": 0,
      "elo_user": 0,
      "engine": "string",
      "fen": "string",
      "model": "string",
      "ply": 0,
      "settings": {
        "depth": 0,
        "lines": 0,
        "time_ms": 0
      },
      "value_elo_maia": 0,
      "value_elo_user": 0
    }
  ]
}
```

<h3 id="reviews-submit-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|body|body|[SubmitBody](#schemasubmitbody)|true|none|

> Example responses

> 202 Response

```json
{
  "$schema": "https://example.com/BatchSubmitted.json",
  "cached": 0,
  "job_id": "string",
  "pending": 0,
  "total": 0
}
```

<h3 id="reviews-submit-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|202|[Accepted](https://tools.ietf.org/html/rfc7231#section-6.3.3)|Accepted|[BatchSubmitted](#schemabatchsubmitted)|
|400|[Bad Request](https://tools.ietf.org/html/rfc7231#section-6.5.1)|Bad Request|[ErrorModel](#schemaerrormodel)|
|422|[Unprocessable Entity](https://tools.ietf.org/html/rfc2518#section-10.3)|Unprocessable Entity|[ErrorModel](#schemaerrormodel)|
|429|[Too Many Requests](https://tools.ietf.org/html/rfc6585#section-4)|Too Many Requests|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|
|502|[Bad Gateway](https://tools.ietf.org/html/rfc7231#section-6.6.3)|Bad Gateway|[ErrorModel](#schemaerrormodel)|

<aside class="success">
This operation does not require authentication
</aside>

## reviews-status

<a id="opIdreviews-status"></a>

> Code samples

```shell
# You can also use wget
curl -X GET /reviews/{id} \
  -H 'Accept: application/json'

```

```http
GET /reviews/{id} HTTP/1.1

Accept: application/json

```

```javascript

const headers = {
  'Accept':'application/json'
};

fetch('/reviews/{id}',
{
  method: 'GET',

  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Accept' => 'application/json'
}

result = RestClient.get '/reviews/{id}',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Accept': 'application/json'
}

r = requests.get('/reviews/{id}', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Accept' => 'application/json',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('GET','/reviews/{id}', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/reviews/{id}");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("GET");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Accept": []string{"application/json"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("GET", "/reviews/{id}", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`GET /reviews/{id}`

*Batch progress (ground truth; the stream is fast-path only)*

<h3 id="reviews-status-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|id|path|string|true|none|

> Example responses

> 200 Response

```json
{
  "$schema": "https://example.com/BatchProgress.json",
  "done": 0,
  "errors": {
    "property1": "string",
    "property2": "string"
  },
  "failed": 0,
  "finished": true,
  "job_id": "string",
  "total": 0
}
```

<h3 id="reviews-status-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|OK|[BatchProgress](#schemabatchprogress)|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Not Found|[ErrorModel](#schemaerrormodel)|
|422|[Unprocessable Entity](https://tools.ietf.org/html/rfc2518#section-10.3)|Unprocessable Entity|[ErrorModel](#schemaerrormodel)|
|500|[Internal Server Error](https://tools.ietf.org/html/rfc7231#section-6.6.1)|Internal Server Error|[ErrorModel](#schemaerrormodel)|

<aside class="success">
This operation does not require authentication
</aside>

## reviews-events

<a id="opIdreviews-events"></a>

> Code samples

```shell
# You can also use wget
curl -X GET /reviews/{id}/events \
  -H 'Accept: text/event-stream'

```

```http
GET /reviews/{id}/events HTTP/1.1

Accept: text/event-stream

```

```javascript

const headers = {
  'Accept':'text/event-stream'
};

fetch('/reviews/{id}/events',
{
  method: 'GET',

  headers: headers
})
.then(function(res) {
    return res.json();
}).then(function(body) {
    console.log(body);
});

```

```ruby
require 'rest-client'
require 'json'

headers = {
  'Accept' => 'text/event-stream'
}

result = RestClient.get '/reviews/{id}/events',
  params: {
  }, headers: headers

p JSON.parse(result)

```

```python
import requests
headers = {
  'Accept': 'text/event-stream'
}

r = requests.get('/reviews/{id}/events', headers = headers)

print(r.json())

```

```php
<?php

require 'vendor/autoload.php';

$headers = array(
    'Accept' => 'text/event-stream',
);

$client = new \GuzzleHttp\Client();

// Define array of request body.
$request_body = array();

try {
    $response = $client->request('GET','/reviews/{id}/events', array(
        'headers' => $headers,
        'json' => $request_body,
       )
    );
    print_r($response->getBody()->getContents());
 }
 catch (\GuzzleHttp\Exception\BadResponseException $e) {
    // handle exception or api errors.
    print_r($e->getMessage());
 }

 // ...

```

```java
URL obj = new URL("/reviews/{id}/events");
HttpURLConnection con = (HttpURLConnection) obj.openConnection();
con.setRequestMethod("GET");
int responseCode = con.getResponseCode();
BufferedReader in = new BufferedReader(
    new InputStreamReader(con.getInputStream()));
String inputLine;
StringBuffer response = new StringBuffer();
while ((inputLine = in.readLine()) != null) {
    response.append(inputLine);
}
in.close();
System.out.println(response.toString());

```

```go
package main

import (
       "bytes"
       "net/http"
)

func main() {

    headers := map[string][]string{
        "Accept": []string{"text/event-stream"},
    }

    data := bytes.NewBuffer([]byte{jsonReq})
    req, err := http.NewRequest("GET", "/reviews/{id}/events", data)
    req.Header = headers

    client := &http.Client{}
    resp, err := client.Do(req)
    // ...
}

```

`GET /reviews/{id}/events`

*Batch progress stream (fast-path; poll is ground truth)*

<h3 id="reviews-events-parameters">Parameters</h3>

|Name|In|Type|Required|Description|
|---|---|---|---|---|
|id|path|string|true|Batch job id|

> Example responses

> 200 Response

<h3 id="reviews-events-responses">Responses</h3>

|Status|Meaning|Description|Schema|
|---|---|---|---|
|200|[OK](https://tools.ietf.org/html/rfc7231#section-6.3.1)|event: progress ticks with the bare batch status JSON, starting with a snapshot. No replay buffer; Last-Event-ID ignored; counters are cumulative so the latest tick supersedes earlier ones. Heartbeat :ping every 15 s; ends when finished is true.|[BatchProgress](#schemabatchprogress)|
|404|[Not Found](https://tools.ietf.org/html/rfc7231#section-6.5.4)|Unknown or evicted job id|None|

<aside class="success">
This operation does not require authentication
</aside>

# Schemas

<h2 id="tocS_BatchLine">BatchLine</h2>
<!-- backwards compatibility -->
<a id="schemabatchline"></a>
<a id="schema_BatchLine"></a>
<a id="tocSbatchline"></a>
<a id="tocsbatchline"></a>

```json
{
  "initial_fen": "string",
  "moves": [
    "string"
  ]
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|initial_fen|string|true|none|none|
|moves|array,null|true|none|none|

<h2 id="tocS_BatchProgress">BatchProgress</h2>
<!-- backwards compatibility -->
<a id="schemabatchprogress"></a>
<a id="schema_BatchProgress"></a>
<a id="tocSbatchprogress"></a>
<a id="tocsbatchprogress"></a>

```json
{
  "$schema": "https://example.com/BatchProgress.json",
  "done": 0,
  "errors": {
    "property1": "string",
    "property2": "string"
  },
  "failed": 0,
  "finished": true,
  "job_id": "string",
  "total": 0
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|done|integer(int64)|true|none|none|
|errors|object|false|none|none|
|» **additionalProperties**|string|false|none|none|
|failed|integer(int64)|true|none|none|
|finished|boolean|true|none|none|
|job_id|string|true|none|none|
|total|integer(int64)|true|none|none|

<h2 id="tocS_BatchSubmitted">BatchSubmitted</h2>
<!-- backwards compatibility -->
<a id="schemabatchsubmitted"></a>
<a id="schema_BatchSubmitted"></a>
<a id="tocSbatchsubmitted"></a>
<a id="tocsbatchsubmitted"></a>

```json
{
  "$schema": "https://example.com/BatchSubmitted.json",
  "cached": 0,
  "job_id": "string",
  "pending": 0,
  "total": 0
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|cached|integer(int64)|true|none|none|
|job_id|string|true|none|none|
|pending|integer(int64)|true|none|none|
|total|integer(int64)|true|none|none|

<h2 id="tocS_DeltaBaseline">DeltaBaseline</h2>
<!-- backwards compatibility -->
<a id="schemadeltabaseline"></a>
<a id="schema_DeltaBaseline"></a>
<a id="tocSdeltabaseline"></a>
<a id="tocsdeltabaseline"></a>

```json
{
  "kind": "string",
  "value": 0.1
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|kind|string|true|none|none|
|value|number(double)|true|none|none|

<h2 id="tocS_ErrorDetail">ErrorDetail</h2>
<!-- backwards compatibility -->
<a id="schemaerrordetail"></a>
<a id="schema_ErrorDetail"></a>
<a id="tocSerrordetail"></a>
<a id="tocserrordetail"></a>

```json
{
  "location": "string",
  "message": "string",
  "value": null
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|location|string|false|none|Where the error occurred, e.g. 'body.items[3].tags' or 'path.thing-id'|
|message|string|false|none|Error message text|
|value|any|false|none|The value at the given location|

<h2 id="tocS_ErrorModel">ErrorModel</h2>
<!-- backwards compatibility -->
<a id="schemaerrormodel"></a>
<a id="schema_ErrorModel"></a>
<a id="tocSerrormodel"></a>
<a id="tocserrormodel"></a>

```json
{
  "$schema": "https://example.com/ErrorModel.json",
  "detail": "Property foo is required but is missing.",
  "errors": [
    {
      "location": "string",
      "message": "string",
      "value": null
    }
  ],
  "instance": "https://example.com/error-log/abc123",
  "status": 400,
  "title": "Bad Request",
  "type": "https://example.com/errors/example"
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|detail|string|false|none|A human-readable explanation specific to this occurrence of the problem.|
|errors|array,null|false|none|Optional list of individual error details|
|instance|string(uri)|false|none|A URI reference that identifies the specific occurrence of the problem.|
|status|integer(int64)|false|none|HTTP status code|
|title|string|false|none|A short, human-readable summary of the problem type. This value should not change between occurrences of the error.|
|type|string(uri)|false|none|A URI reference to human-readable documentation for the error.|

<h2 id="tocS_EvaluationLine">EvaluationLine</h2>
<!-- backwards compatibility -->
<a id="schemaevaluationline"></a>
<a id="schema_EvaluationLine"></a>
<a id="tocSevaluationline"></a>
<a id="tocsevaluationline"></a>

```json
{
  "depth": 0,
  "move": "string",
  "pv": [
    "string"
  ],
  "score": {
    "type": "string",
    "value": 0,
    "winning_side": "string"
  }
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|depth|integer(int64)|true|none|none|
|move|string|true|none|none|
|pv|array,null|false|none|none|
|score|[EvaluationScore](#schemaevaluationscore)|true|none|none|

<h2 id="tocS_EvaluationRequest">EvaluationRequest</h2>
<!-- backwards compatibility -->
<a id="schemaevaluationrequest"></a>
<a id="schema_EvaluationRequest"></a>
<a id="tocSevaluationrequest"></a>
<a id="tocsevaluationrequest"></a>

```json
{
  "$schema": "https://example.com/EvaluationRequest.json",
  "fen": "string",
  "initial_fen": "string",
  "moves": [
    "string"
  ],
  "settings": {
    "depth": 0,
    "lines": 0,
    "time_ms": 0
  }
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|fen|string|true|none|none|
|initial_fen|string|false|none|none|
|moves|array,null|true|none|none|
|settings|[StockfishSettings](#schemastockfishsettings)|false|none|none|

<h2 id="tocS_EvaluationResponse">EvaluationResponse</h2>
<!-- backwards compatibility -->
<a id="schemaevaluationresponse"></a>
<a id="schema_EvaluationResponse"></a>
<a id="tocSevaluationresponse"></a>
<a id="tocsevaluationresponse"></a>

```json
{
  "$schema": "https://example.com/EvaluationResponse.json",
  "actual_settings": {
    "depth": 0,
    "lines": 0,
    "time_ms": 0
  },
  "best_move": "string",
  "depth": 0,
  "engine": "string",
  "lines": [
    {
      "depth": 0,
      "move": "string",
      "pv": [
        "string"
      ],
      "score": {
        "type": "string",
        "value": 0,
        "winning_side": "string"
      }
    }
  ],
  "score": {
    "type": "string",
    "value": 0,
    "winning_side": "string"
  },
  "search_policy": "string",
  "terminal": "string"
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|actual_settings|[StockfishSettings](#schemastockfishsettings)|false|none|none|
|best_move|string,null|true|none|none|
|depth|integer(int64)|true|none|none|
|engine|string|true|none|none|
|lines|array,null|true|none|none|
|score|[EvaluationScore](#schemaevaluationscore)|true|none|none|
|search_policy|string|true|none|none|
|terminal|string,null|true|none|none|

<h2 id="tocS_EvaluationScore">EvaluationScore</h2>
<!-- backwards compatibility -->
<a id="schemaevaluationscore"></a>
<a id="schema_EvaluationScore"></a>
<a id="tocSevaluationscore"></a>
<a id="tocsevaluationscore"></a>

```json
{
  "type": "string",
  "value": 0,
  "winning_side": "string"
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|type|string|true|none|none|
|value|integer(int64)|true|none|none|
|winning_side|string|false|none|none|

<h2 id="tocS_GamePayload">GamePayload</h2>
<!-- backwards compatibility -->
<a id="schemagamepayload"></a>
<a id="schema_GamePayload"></a>
<a id="tocSgamepayload"></a>
<a id="tocsgamepayload"></a>

```json
{
  "$schema": "https://example.com/GamePayload.json",
  "clocks": [
    0
  ],
  "created_at": "string",
  "current": true,
  "elo_maia": 0,
  "elo_user": 0,
  "id": "string",
  "model": "string",
  "moves": [
    "string"
  ],
  "opponent": "string",
  "owner_id": "string",
  "rating_diff": 0,
  "result": "string",
  "source": "string",
  "speed": "string",
  "temperature": 0.1,
  "time_control": "string",
  "user_color": "string"
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|clocks|array,null|false|none|none|
|created_at|string|false|none|none|
|current|boolean|false|none|none|
|elo_maia|integer,null(int64)|true|none|none|
|elo_user|integer,null(int64)|true|none|none|
|id|string|false|none|none|
|model|string|true|none|none|
|moves|array,null|true|none|none|
|opponent|string|false|none|none|
|owner_id|string|false|none|none|
|rating_diff|integer(int64)|false|none|none|
|result|string|false|none|none|
|source|string|false|none|none|
|speed|string|false|none|none|
|temperature|number(double)|false|none|none|
|time_control|string|false|none|none|
|user_color|string|true|none|none|

<h2 id="tocS_GameRow">GameRow</h2>
<!-- backwards compatibility -->
<a id="schemagamerow"></a>
<a id="schema_GameRow"></a>
<a id="tocSgamerow"></a>
<a id="tocsgamerow"></a>

```json
{
  "$schema": "https://example.com/GameRow.json",
  "clocks": [
    0
  ],
  "created_at": "string",
  "elo_maia": 0,
  "elo_user": 0,
  "id": "string",
  "model": "string",
  "moves": [
    "string"
  ],
  "opponent": "string",
  "owner_id": "string",
  "rating_diff": 0,
  "result": "string",
  "source": "string",
  "speed": "string",
  "temperature": 0.1,
  "time_control": "string",
  "updated_at": "string",
  "user_color": "string"
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|clocks|array,null|false|none|none|
|created_at|string|true|none|none|
|elo_maia|integer(int64)|true|none|none|
|elo_user|integer(int64)|true|none|none|
|id|string|true|none|none|
|model|string|true|none|none|
|moves|array,null|true|none|none|
|opponent|string|false|none|none|
|owner_id|string|false|none|none|
|rating_diff|integer(int64)|false|none|none|
|result|string|false|none|none|
|source|string|false|none|none|
|speed|string|false|none|none|
|temperature|number(double)|true|none|none|
|time_control|string|false|none|none|
|updated_at|string|true|none|none|
|user_color|string|true|none|none|

<h2 id="tocS_GamesPage">GamesPage</h2>
<!-- backwards compatibility -->
<a id="schemagamespage"></a>
<a id="schema_GamesPage"></a>
<a id="tocSgamespage"></a>
<a id="tocsgamespage"></a>

```json
{
  "$schema": "https://example.com/GamesPage.json",
  "current_game": {
    "$schema": "https://example.com/GameRow.json",
    "clocks": [
      0
    ],
    "created_at": "string",
    "elo_maia": 0,
    "elo_user": 0,
    "id": "string",
    "model": "string",
    "moves": [
      "string"
    ],
    "opponent": "string",
    "owner_id": "string",
    "rating_diff": 0,
    "result": "string",
    "source": "string",
    "speed": "string",
    "temperature": 0.1,
    "time_control": "string",
    "updated_at": "string",
    "user_color": "string"
  },
  "current_id": "string",
  "games": [
    {
      "$schema": "https://example.com/GameRow.json",
      "clocks": [
        0
      ],
      "created_at": "string",
      "elo_maia": 0,
      "elo_user": 0,
      "id": "string",
      "model": "string",
      "moves": [
        "string"
      ],
      "opponent": "string",
      "owner_id": "string",
      "rating_diff": 0,
      "result": "string",
      "source": "string",
      "speed": "string",
      "temperature": 0.1,
      "time_control": "string",
      "updated_at": "string",
      "user_color": "string"
    }
  ],
  "next_offset": 0,
  "total": 0
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|current_game|[GameRow](#schemagamerow)|false|none|none|
|current_id|string,null|true|none|none|
|games|array,null|true|none|none|
|next_offset|integer,null(int64)|true|none|none|
|total|integer(int64)|true|none|none|

<h2 id="tocS_HealthBody">HealthBody</h2>
<!-- backwards compatibility -->
<a id="schemahealthbody"></a>
<a id="schema_HealthBody"></a>
<a id="tocShealthbody"></a>
<a id="tocshealthbody"></a>

```json
{
  "$schema": "https://example.com/HealthBody.json",
  "models": {
    "property1": {
      "last_error": "string",
      "state": "string"
    },
    "property2": {
      "last_error": "string",
      "state": "string"
    }
  },
  "status": "string"
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|models|object|true|none|none|
|» **additionalProperties**|[WorkerStatus](#schemaworkerstatus)|false|none|none|
|status|string|true|none|none|

<h2 id="tocS_ImportRun">ImportRun</h2>
<!-- backwards compatibility -->
<a id="schemaimportrun"></a>
<a id="schema_ImportRun"></a>
<a id="tocSimportrun"></a>
<a id="tocsimportrun"></a>

```json
{
  "created_at": "string",
  "id": "string",
  "provider": "string",
  "requested": 0,
  "saved": 0,
  "skipped": 0,
  "user_id": "string",
  "username": "string"
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|created_at|string|true|none|none|
|id|string|true|none|none|
|provider|string|true|none|none|
|requested|integer(int64)|true|none|none|
|saved|integer(int64)|true|none|none|
|skipped|integer(int64)|true|none|none|
|user_id|string|true|none|none|
|username|string|true|none|none|

<h2 id="tocS_ImportStatusBody">ImportStatusBody</h2>
<!-- backwards compatibility -->
<a id="schemaimportstatusbody"></a>
<a id="schema_ImportStatusBody"></a>
<a id="tocSimportstatusbody"></a>
<a id="tocsimportstatusbody"></a>

```json
{
  "$schema": "https://example.com/ImportStatusBody.json",
  "last": {
    "created_at": "string",
    "id": "string",
    "provider": "string",
    "requested": 0,
    "saved": 0,
    "skipped": 0,
    "user_id": "string",
    "username": "string"
  },
  "total": 0
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|last|[ImportRun](#schemaimportrun)|true|none|none|
|total|integer(int64)|true|none|none|

<h2 id="tocS_LichessCallbackBody">LichessCallbackBody</h2>
<!-- backwards compatibility -->
<a id="schemalichesscallbackbody"></a>
<a id="schema_LichessCallbackBody"></a>
<a id="tocSlichesscallbackbody"></a>
<a id="tocslichesscallbackbody"></a>

```json
{
  "$schema": "https://example.com/LichessCallbackBody.json",
  "code": "string",
  "state": "string"
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|code|string|true|none|none|
|state|string|true|none|none|

<h2 id="tocS_LichessStartBody">LichessStartBody</h2>
<!-- backwards compatibility -->
<a id="schemalichessstartbody"></a>
<a id="schema_LichessStartBody"></a>
<a id="tocSlichessstartbody"></a>
<a id="tocslichessstartbody"></a>

```json
{
  "$schema": "https://example.com/LichessStartBody.json",
  "authorization_url": "string",
  "state": "string"
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|authorization_url|string|true|none|none|
|state|string|true|none|none|

<h2 id="tocS_LoginInputBody">LoginInputBody</h2>
<!-- backwards compatibility -->
<a id="schemalogininputbody"></a>
<a id="schema_LoginInputBody"></a>
<a id="tocSlogininputbody"></a>
<a id="tocslogininputbody"></a>

```json
{
  "$schema": "https://example.com/LoginInputBody.json",
  "display_name": "string"
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|display_name|string|true|none|none|

<h2 id="tocS_LookupBody">LookupBody</h2>
<!-- backwards compatibility -->
<a id="schemalookupbody"></a>
<a id="schema_LookupBody"></a>
<a id="tocSlookupbody"></a>
<a id="tocslookupbody"></a>

```json
{
  "$schema": "https://example.com/LookupBody.json",
  "line": {
    "initial_fen": "string",
    "moves": [
      "string"
    ]
  },
  "requests": [
    {
      "elo_maia": 0,
      "elo_user": 0,
      "engine": "string",
      "fen": "string",
      "model": "string",
      "ply": 0,
      "settings": {
        "depth": 0,
        "lines": 0,
        "time_ms": 0
      },
      "value_elo_maia": 0,
      "value_elo_user": 0
    }
  ]
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|line|[BatchLine](#schemabatchline)|true|none|none|
|requests|array,null|true|none|none|

<h2 id="tocS_LookupRequest">LookupRequest</h2>
<!-- backwards compatibility -->
<a id="schemalookuprequest"></a>
<a id="schema_LookupRequest"></a>
<a id="tocSlookuprequest"></a>
<a id="tocslookuprequest"></a>

```json
{
  "elo_maia": 0,
  "elo_user": 0,
  "engine": "string",
  "fen": "string",
  "model": "string",
  "ply": 0,
  "settings": {
    "depth": 0,
    "lines": 0,
    "time_ms": 0
  },
  "value_elo_maia": 0,
  "value_elo_user": 0
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|elo_maia|integer(int64)|false|none|none|
|elo_user|integer(int64)|false|none|none|
|engine|string|true|none|none|
|fen|string|true|none|none|
|model|string|false|none|none|
|ply|integer(int64)|true|none|none|
|settings|[StockfishSettings](#schemastockfishsettings)|false|none|none|
|value_elo_maia|integer(int64)|false|none|none|
|value_elo_user|integer(int64)|false|none|none|

<h2 id="tocS_LookupResult">LookupResult</h2>
<!-- backwards compatibility -->
<a id="schemalookupresult"></a>
<a id="schema_LookupResult"></a>
<a id="tocSlookupresult"></a>
<a id="tocslookupresult"></a>

```json
{
  "actual_settings": {
    "depth": 0,
    "lines": 0,
    "time_ms": 0
  },
  "index": 0,
  "value": null
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|actual_settings|[StockfishSettings](#schemastockfishsettings)|false|none|none|
|index|integer(int64)|true|none|none|
|value|any|true|none|none|

<h2 id="tocS_LookupResults">LookupResults</h2>
<!-- backwards compatibility -->
<a id="schemalookupresults"></a>
<a id="schema_LookupResults"></a>
<a id="tocSlookupresults"></a>
<a id="tocslookupresults"></a>

```json
{
  "$schema": "https://example.com/LookupResults.json",
  "results": [
    {
      "actual_settings": {
        "depth": 0,
        "lines": 0,
        "time_ms": 0
      },
      "index": 0,
      "value": null
    }
  ]
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|results|array,null|true|none|none|

<h2 id="tocS_Match">Match</h2>
<!-- backwards compatibility -->
<a id="schemamatch"></a>
<a id="schema_Match"></a>
<a id="tocSmatch"></a>
<a id="tocsmatch"></a>

```json
{
  "eco": "string",
  "name": "string",
  "ply": 0
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|eco|string|true|none|none|
|name|string|true|none|none|
|ply|integer(int64)|true|none|none|

<h2 id="tocS_MoveRequest">MoveRequest</h2>
<!-- backwards compatibility -->
<a id="schemamoverequest"></a>
<a id="schema_MoveRequest"></a>
<a id="tocSmoverequest"></a>
<a id="tocsmoverequest"></a>

```json
{
  "$schema": "https://example.com/MoveRequest.json",
  "elo_maia": 0,
  "elo_user": 0,
  "fen": "string",
  "initial_fen": "string",
  "maia_color": "string",
  "model": "string",
  "moves": [
    "string"
  ],
  "temperature": 0.1,
  "value_elo_maia": 0,
  "value_elo_user": 0
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|elo_maia|integer,null(int64)|true|none|none|
|elo_user|integer,null(int64)|true|none|none|
|fen|string|true|none|none|
|initial_fen|string|false|none|none|
|maia_color|string|true|none|none|
|model|string|true|none|none|
|moves|array,null|true|none|none|
|temperature|number(double)|false|none|none|
|value_elo_maia|integer(int64)|false|none|none|
|value_elo_user|integer(int64)|false|none|none|

<h2 id="tocS_MoveResponse">MoveResponse</h2>
<!-- backwards compatibility -->
<a id="schemamoveresponse"></a>
<a id="schema_MoveResponse"></a>
<a id="tocSmoveresponse"></a>
<a id="tocsmoveresponse"></a>

```json
{
  "$schema": "https://example.com/MoveResponse.json",
  "degraded": true,
  "delta_baseline": {
    "kind": "string",
    "value": 0.1
  },
  "model_used": "string",
  "move": "string",
  "top_moves": [
    {
      "delta": 0.1,
      "move": "string",
      "prob": 0.1,
      "wdl": [
        0.1,
        0.1,
        0.1
      ]
    }
  ],
  "wdl": [
    0.1,
    0.1,
    0.1
  ]
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|degraded|boolean|true|none|none|
|delta_baseline|[DeltaBaseline](#schemadeltabaseline)|false|none|none|
|model_used|string|true|none|none|
|move|string|true|none|none|
|top_moves|array,null|true|none|none|
|wdl|array,null|true|none|none|

<h2 id="tocS_Request">Request</h2>
<!-- backwards compatibility -->
<a id="schemarequest"></a>
<a id="schema_Request"></a>
<a id="tocSrequest"></a>
<a id="tocsrequest"></a>

```json
{
  "$schema": "https://example.com/Request.json",
  "initial_fen": "string",
  "moves": [
    "string"
  ]
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|initial_fen|string|false|none|none|
|moves|array,null|true|none|none|

<h2 id="tocS_Response">Response</h2>
<!-- backwards compatibility -->
<a id="schemaresponse"></a>
<a id="schema_Response"></a>
<a id="tocSresponse"></a>
<a id="tocsresponse"></a>

```json
{
  "$schema": "https://example.com/Response.json",
  "book_flags": [
    true
  ],
  "degraded": true,
  "matches": [
    {
      "eco": "string",
      "name": "string",
      "ply": 0
    }
  ]
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|book_flags|array,null|true|none|none|
|degraded|boolean|false|none|none|
|matches|array,null|true|none|none|

<h2 id="tocS_StockfishSettings">StockfishSettings</h2>
<!-- backwards compatibility -->
<a id="schemastockfishsettings"></a>
<a id="schema_StockfishSettings"></a>
<a id="tocSstockfishsettings"></a>
<a id="tocsstockfishsettings"></a>

```json
{
  "depth": 0,
  "lines": 0,
  "time_ms": 0
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|depth|integer(int64)|true|none|none|
|lines|integer(int64)|true|none|none|
|time_ms|integer(int64)|true|none|none|

<h2 id="tocS_SubmitBody">SubmitBody</h2>
<!-- backwards compatibility -->
<a id="schemasubmitbody"></a>
<a id="schema_SubmitBody"></a>
<a id="tocSsubmitbody"></a>
<a id="tocssubmitbody"></a>

```json
{
  "$schema": "https://example.com/SubmitBody.json",
  "line": {
    "initial_fen": "string",
    "moves": [
      "string"
    ]
  },
  "requests": [
    {
      "elo_maia": 0,
      "elo_user": 0,
      "engine": "string",
      "fen": "string",
      "model": "string",
      "ply": 0,
      "settings": {
        "depth": 0,
        "lines": 0,
        "time_ms": 0
      },
      "value_elo_maia": 0,
      "value_elo_user": 0
    }
  ]
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|line|[BatchLine](#schemabatchline)|true|none|none|
|requests|array,null|true|none|none|

<h2 id="tocS_TopMove">TopMove</h2>
<!-- backwards compatibility -->
<a id="schematopmove"></a>
<a id="schema_TopMove"></a>
<a id="tocStopmove"></a>
<a id="tocstopmove"></a>

```json
{
  "delta": 0.1,
  "move": "string",
  "prob": 0.1,
  "wdl": [
    0.1,
    0.1,
    0.1
  ]
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|delta|number(double)|false|none|none|
|move|string|true|none|none|
|prob|number(double)|true|none|none|
|wdl|array,null|true|none|none|

<h2 id="tocS_User">User</h2>
<!-- backwards compatibility -->
<a id="schemauser"></a>
<a id="schema_User"></a>
<a id="tocSuser"></a>
<a id="tocsuser"></a>

```json
{
  "$schema": "https://example.com/User.json",
  "created_at": "string",
  "display_name": "string",
  "id": "string",
  "lichess_id": "string",
  "lichess_username": "string"
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|$schema|string(uri)|false|read-only|A URL to the JSON Schema for this object.|
|created_at|string|true|none|none|
|display_name|string|true|none|none|
|id|string|true|none|none|
|lichess_id|string|false|none|none|
|lichess_username|string|false|none|none|

<h2 id="tocS_WorkerStatus">WorkerStatus</h2>
<!-- backwards compatibility -->
<a id="schemaworkerstatus"></a>
<a id="schema_WorkerStatus"></a>
<a id="tocSworkerstatus"></a>
<a id="tocsworkerstatus"></a>

```json
{
  "last_error": "string",
  "state": "string"
}

```

### Properties

|Name|Type|Required|Restrictions|Description|
|---|---|---|---|---|
|last_error|string|false|none|none|
|state|string|true|none|none|

