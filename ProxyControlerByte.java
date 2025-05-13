package com.reverseproxy;
import com.google.gson.Gson;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.ibm.icu.text.CharsetDetector;
import com.ibm.icu.text.CharsetMatch;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.*;
import org.springframework.http.converter.json.MappingJackson2HttpMessageConverter;
import org.springframework.util.MultiValueMap;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;

import java.io.UnsupportedEncodingException;
import java.util.List;
import java.util.Map;

@RestController

public class ProxyControlerByte {

    @RequestMapping("/**")
    public ResponseEntity<byte[]> proxy44proxy(
            HttpServletRequest request,
            @RequestBody(required = false) String requestBody,
            @RequestHeader Map<String, String> headers,
            @RequestParam MultiValueMap<String, String> queryParams,
            HttpMethod method,
            String path) {
        if (requestBody == null || requestBody.isEmpty()) {
            throw new IllegalArgumentException("Request body is null or empty");
        }
        String fullUrl = request.getRequestURL().toString();
        String queryString = request.getQueryString();
        if (queryString != null) {
            fullUrl += "?" + queryString;
        }
        System.out.println("fullUrl:" + fullUrl);
        System.out.println("path:" + path);
        System.out.println("queryParams:" + queryParams);
        System.out.println("method:" + method);
        System.out.println("headers:" + headers);
        System.out.println("requestBody:" + requestBody);

        JsonObject jsonObject1 = convertStringToJsonObject(requestBody);

        Gson gson = new Gson();
        String modifyRequestBody = gson.toJson(jsonObject1);

        System.out.println("modifyRequestBody:" + modifyRequestBody);

        HttpHeaders reqHeaders = new HttpHeaders();
        reqHeaders.setContentType(MediaType.APPLICATION_JSON);
        headers.forEach(reqHeaders::add);

        RestTemplate restTemplate = new RestTemplate();

        MappingJackson2HttpMessageConverter converter = new MappingJackson2HttpMessageConverter();
        converter.setSupportedMediaTypes(List.of(MediaType.TEXT_EVENT_STREAM, MediaType.APPLICATION_JSON));
        restTemplate.getMessageConverters().add(converter);

        String url = "https://api.openai.com/v1/chat/completions";

        if (queryString != null) {
            url += "?" + queryString;
        }

        HttpEntity<String> entity = new HttpEntity<>(requestBody, reqHeaders);

        ResponseEntity<byte[]> response = restTemplate.exchange(url, method, entity, byte[].class);

        System.out.println("Response Headers:");
        response.getHeaders().forEach((key, value) -> System.out.println(key + ": " + value));

        System.out.println("Response Body:");
        System.out.println(new String(response.getBody()));

        System.out.println("Response Status Code:");
        System.out.println(response.getStatusCode());
        return new ResponseEntity<>(response.getBody(), response.getStatusCode());
    }

    public static JsonObject convertStringToJsonObject(String jsonString) {
        Gson gson = new Gson();
        System.out.println("jsonString:" + jsonString);
        JsonObject jsonObject = JsonParser.parseString(jsonString).getAsJsonObject();
        return jsonObject;
    }

    private byte[] change(byte[] requestBody) {
        //JsonObject jsonObject = convertStringToJsonObject(new String(requestBody ,StandardCharsets.UTF_8));
        JsonObject jsonObject = convertStringToJsonObject(new String(requestBody));
        jsonObject.remove("stream");
        Gson gson = new Gson();
        return gson.toJson(jsonObject).getBytes();
    }



    public static String detectCodepage(byte[] bytes) {
        CharsetDetector detector = new CharsetDetector();
        detector.setText(bytes);
        CharsetMatch match = detector.detect();

        if (match != null) {
            return match.getName();
        } else {
            return "Unknown";
        }
    }
}
