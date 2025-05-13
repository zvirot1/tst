package com.reverseproxy;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.web.server.ServerWebExchange;
import reactor.core.publisher.Mono;
import org.springframework.core.io.buffer.DataBuffer;
import org.springframework.core.io.buffer.DataBufferUtils;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.*;

@RestController
public class ProxyController {

    private static final Logger logger = LoggerFactory.getLogger(ProxyController.class);

    private final WebClient webClient;

    @Value("${proxy.target.url}")
    private String targetUrl;

    public ProxyController(WebClient.Builder webClientBuilder) {
        this.webClient = webClientBuilder.build();
    }

    @RequestMapping("/TT/**")
    public Mono<ResponseEntity<byte[]>> proxy(ServerWebExchange exchange) {
        String path = exchange.getRequest().getURI().getPath();
        String query = exchange.getRequest().getURI().getQuery();
        //String url = targetUrl + path + (query != null ? "?" + query : "");

        String url ="http:/xxxxxxxxxxxxxxxxxxxxxxxxxxx";
        logger.info("Proxying request to URL: {}", url);
        logger.info("Request method: {}", exchange.getRequest().getMethod());
        logger.info("Request headers: {}", exchange.getRequest().getHeaders());

        HttpHeaders requestHeaders = new HttpHeaders();

        requestHeaders.addAll(exchange.getRequest().getHeaders());
        List<String>  accepts= requestHeaders.get("Accept");


        requestHeaders.remove("Accept");
        requestHeaders.remove("Authorization");
        requestHeaders.remove("Postman-Token");
        requestHeaders.remove("Pragma");
        requestHeaders.remove("Host");
        requestHeaders.remove("User-Agent");

        requestHeaders.add("Accept" ,"*/*");

        //requestHeaders.add("Accept-Encoding" ,"gzip, deflate, br");

        //requestHeaders.put("Accept" ,newAccepts);

        //requestHeaders.set("Accept" , newAccepts);
        //requestHeaders.remove("Q"); // הסר את הכותרת עם המפתח "Q"
        //requestHeaders.remove("q");
        logger.info("Modify Request headers: {}", requestHeaders);


        return DataBufferUtils.join(exchange.getRequest().getBody())
                .flatMap(dataBuffer -> {
                    ByteBuffer byteBuffer = dataBuffer.asByteBuffer();
                    byte[] bytes = new byte[byteBuffer.remaining()];
                    byteBuffer.get(bytes);
                    String body = new String(bytes, StandardCharsets.UTF_8);
                    logger.info("Request body: {}", body);


                    WebClient.RequestBodySpec requestBodySpec = webClient.method(exchange.getRequest().getMethod())
                            .uri(url)
                            .headers(headers -> {
                                headers.addAll(requestHeaders);
                                headers.add("X-APG-APIKey", "xxxxxxxxxxxxxxxxxxxxxxxxx"); // הוסף את הכותרת שלך כאן
                            });

                    return requestBodySpec
                            .bodyValue(body)
                            .exchangeToMono(response -> response.bodyToMono(DataBuffer.class)
                                    .flatMap(responseDataBuffer -> {
                                        ByteBuffer responseByteBuffer = responseDataBuffer.asByteBuffer();
                                        byte[] responseBytes = new byte[responseByteBuffer.remaining()];
                                        responseByteBuffer.get(responseBytes);
                                        String responseBody = new String(responseBytes, StandardCharsets.UTF_8);
                                        logger.info("Response body: {}", responseBody);

                                        return Mono.just(ResponseEntity.status(response.statusCode())
                                                .headers(response.headers().asHttpHeaders())
                                                .body(responseBytes));
                                    }));
                });
    }
}