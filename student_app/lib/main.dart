import 'package:flutter/material.dart';
import 'controllers/app_controller.dart';
import 'data/api_client.dart';
import 'data/journal.dart';
import 'ui/campus_app.dart';
import 'ui/components.dart';
import 'ui/style.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  runApp(const Bootstrap());
}

class Bootstrap extends StatefulWidget {
  const Bootstrap({super.key});
  @override
  State<Bootstrap> createState() => _BootstrapState();
}

class _BootstrapState extends State<Bootstrap> {
  AppController? _controller;
  String? _failure;

  @override
  void initState() {
    super.initState();
    _start();
  }

  Future<void> _start() async {
    setState(() => _failure = null);
    try {
      final journal = await DurableJournal.open();
      final api = ApiClient(
        origin: const String.fromEnvironment(
          'API_ORIGIN',
          defaultValue: 'http://127.0.0.1:18765',
        ),
      );
      final controller = AppController(api: api, journal: journal);
      if (!mounted) {
        controller.dispose();
        return;
      }
      setState(() => _controller = controller);
      await controller.initialize();
    } catch (error) {
      if (mounted) {
        setState(() {
          _controller = null;
          _failure = error.toString();
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_controller != null) return CampusApp(controller: _controller!);
    return MaterialApp(
      title: '知行 · 校园助理',
      debugShowCheckedModeBanner: false,
      theme: campusTheme(),
      home: Scaffold(
        body: SafeArea(
          child: Column(
            children: [
              const DemoBanner(),
              Expanded(
                child: Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 520),
                    child: Padding(
                      padding: const EdgeInsets.all(28),
                      child: _failure == null
                          ? const Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                CircularProgressIndicator(),
                                SizedBox(height: 22),
                                Text('正在准备知行…'),
                              ],
                            )
                          : EmptyState(
                              title: '暂时无法启动',
                              message: _failure!,
                              icon: Icons.error_outline_rounded,
                              action: FilledButton(
                                onPressed: _start,
                                child: const Text('重新启动'),
                              ),
                            ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
