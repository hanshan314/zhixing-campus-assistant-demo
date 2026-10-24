import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
import '../domain/models.dart';
export '../domain/models.dart' show Json;

class ApiFailure implements Exception {
  ApiFailure(
    this.code,
    this.message, {
    this.status = 0,
    this.requestId,
    this.details = const {},
  });
  final String code;
  final String message;
  final int status;
  final String? requestId;
  final Json details;
  bool get definitiveRejection =>
      code != 'IDEMPOTENCY_KEY_REUSED' &&
      status >= 400 &&
      status < 500 &&
      status != 401 &&
      status != 403 &&
      status != 408 &&
      status != 429;
  @override
  String toString() => message;
}

class StaleSession implements Exception {}

/// Transport only; never automatically retries writes or silently switches to Mock.
class ApiClient {
  ApiClient({
    required this.origin,
    http.Client? client,
    this.timeout = const Duration(seconds: 15),
  }) : client = client ?? http.Client() {
    final uri = Uri.parse(origin);
    if (!['127.0.0.1', 'localhost', '10.0.2.2'].contains(uri.host) ||
        !['http', 'https'].contains(uri.scheme) ||
        (uri.path.isNotEmpty && uri.path != '/') ||
        uri.query.isNotEmpty ||
        uri.userInfo.isNotEmpty) {
      throw ArgumentError('演示构建只连接本机或 Android 模拟器的本机服务。');
    }
  }
  final String origin;
  final http.Client client;
  final Duration timeout;
  String? _token;
  int epoch = 0;

  void useDemoAccount(String? account) {
    if (account != null && !['a', 'b'].contains(account)) {
      throw ArgumentError('Unknown demo account');
    }
    epoch++;
    _token = account == null ? null : 'demo-student-$account';
  }

  Future<Json> request(
    String method,
    String path, {
    Json? body,
    String? key,
    bool control = false,
  }) async {
    if (!path.startsWith(control ? '/__demo/' : '/v1/') ||
        path.startsWith('//')) {
      throw ArgumentError('Unknown API path');
    }
    final generation = epoch;
    final request = http.Request(method, Uri.parse('$origin$path'));
    request.headers['Accept'] = 'application/json';
    if (_token != null) request.headers['Authorization'] = 'Bearer $_token';
    if (key != null) request.headers['Idempotency-Key'] = key;
    if (body != null) {
      request.headers['Content-Type'] = 'application/json';
      request.body = jsonEncode(body);
    }
    return _send(request, generation, control: control);
  }

  Future<Json> upload(
    String taskId,
    String filename,
    Uint8List bytes,
    String key, {
    String mime = 'application/pdf',
  }) async {
    final generation = epoch;
    final request = http.MultipartRequest(
      'POST',
      Uri.parse('$origin/v1/files'),
    );
    if (_token != null) request.headers['Authorization'] = 'Bearer $_token';
    request.headers['Idempotency-Key'] = key;
    request.fields.addAll({
      'purpose': 'submission_material',
      'task_id': taskId,
    });
    request.files.add(
      http.MultipartFile.fromBytes(
        'file',
        bytes,
        filename: filename,
        contentType: MediaType.parse(mime),
      ),
    );
    return _send(request, generation);
  }

  Future<Uint8List> downloadFile(String fileId) async {
    final generation = epoch;
    final request = http.Request(
      'GET',
      Uri.parse('$origin/v1/files/${Uri.encodeComponent(fileId)}/content'),
    );
    request.followRedirects = false;
    request.headers['Accept'] = 'application/octet-stream';
    if (_token != null) request.headers['Authorization'] = 'Bearer $_token';
    try {
      final response = await (() async {
        final stream = await client.send(request);
        return http.Response.fromStream(stream);
      })().timeout(timeout);
      if (generation != epoch) throw StaleSession();
      if (response.statusCode != 200) {
        Json envelope = {};
        try {
          envelope = Map<String, dynamic>.from(
            jsonDecode(utf8.decode(response.bodyBytes)) as Map,
          );
        } catch (_) {
          /* No private content is included in an error. */
        }
        final error = Map<String, dynamic>.from(
          envelope['error'] as Map? ?? {},
        );
        if (response.statusCode == 401) {
          epoch++;
          _token = null;
        }
        throw ApiFailure(
          error['code'] as String? ?? 'DOWNLOAD_FAILED',
          error['message'] as String? ?? '无法取得原文件。',
          status: response.statusCode,
          requestId: (envelope['meta'] as Map?)?['request_id'] as String?,
        );
      }
      return response.bodyBytes;
    } on TimeoutException {
      if (generation != epoch) throw StaleSession();
      throw ApiFailure('NETWORK_UNKNOWN', '下载超时，请稍后重新获取原文件。');
    } on http.ClientException {
      if (generation != epoch) throw StaleSession();
      throw ApiFailure('NETWORK_UNKNOWN', '连接中断，原文件未能下载。');
    }
  }

  Future<Json> _send(
    http.BaseRequest request,
    int generation, {
    bool control = false,
  }) async {
    try {
      final response = await (() async {
        final stream = await client.send(request);
        return http.Response.fromStream(stream);
      })().timeout(timeout);
      if (generation != epoch) throw StaleSession();
      final Json envelope;
      try {
        envelope = Map<String, dynamic>.from(
          jsonDecode(utf8.decode(response.bodyBytes)) as Map,
        );
      } catch (_) {
        throw ApiFailure('INVALID_RESPONSE', '服务返回无法识别的结果；写入状态需要核对。');
      }
      if (response.statusCode >= 400) {
        final error = Map<String, dynamic>.from(
          envelope['error'] as Map? ?? {},
        );
        if (response.statusCode == 401) {
          epoch++;
          _token = null;
        }
        throw ApiFailure(
          error['code'] as String? ?? 'HTTP_ERROR',
          error['message'] as String? ?? '请求未完成',
          status: response.statusCode,
          requestId: (envelope['meta'] as Map?)?['request_id'] as String?,
          details: Map<String, dynamic>.from(error['details'] as Map? ?? {}),
        );
      }
      if (!control && (envelope['meta'] as Map?)?['mode'] != 'demo') {
        throw ApiFailure('MODE_MISMATCH', '当前版本仅支持隔离演示，拒绝接入未核验的真实数据。');
      }
      if (control) return envelope;
      if (envelope['data'] is! Map) {
        throw ApiFailure('INVALID_RESPONSE', '接口 data 结构不匹配。');
      }
      return Map<String, dynamic>.from(envelope['data'] as Map);
    } on TimeoutException {
      if (generation != epoch) throw StaleSession();
      throw ApiFailure('NETWORK_UNKNOWN', '请求超时，服务端结果可能已经保存。');
    } on http.ClientException {
      if (generation != epoch) throw StaleSession();
      throw ApiFailure('NETWORK_UNKNOWN', '连接中断或服务未启动，请核对原操作结果。');
    }
  }

  void close() => client.close();
}
