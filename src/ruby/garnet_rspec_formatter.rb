# Loaded by Garnet with `rspec --require <this file> --format GarnetFormatter`.
# Writes one JSON object per line to $GARNET_TEST_EVENTS for the test results tree.
require "json"

class GarnetFormatter
  RSpec::Core::Formatters.register self, :start, :example_passed, :example_failed, :example_pending, :dump_summary

  def initialize(_output)
    @out = File.open(ENV.fetch("GARNET_TEST_EVENTS"), "a")
    @out.sync = true
  end

  def start(notification)
    emit(event: "start", count: notification.count)
  end

  def example_passed(n)
    result(n.example, "passed")
  end

  def example_pending(n)
    result(n.example, "pending", message: n.example.execution_result.pending_message)
  end

  def example_failed(n)
    e = n.exception
    result(n.example, "failed", message: "#{e.class}: #{e.message}", backtrace: n.formatted_backtrace.map(&:to_s))
  end

  def dump_summary(n)
    emit(event: "done", duration: n.duration)
    @out.close
  end

  private

  def result(example, status, message: nil, backtrace: nil)
    file = File.expand_path(example.metadata[:file_path])
    groups = example.example_group.parent_groups.reverse.map do |g|
      { name: g.description.to_s, line: (g.metadata[:line_number] if File.expand_path(g.metadata[:file_path]) == file) }
    end
    emit(event: "result", id: example.id, file: file, line: example.metadata[:line_number], groups: groups,
         name: example.description.to_s, status: status, duration: example.execution_result.run_time.to_f,
         message: message, backtrace: backtrace)
  end

  def emit(hash)
    @out.puts(JSON.generate(hash.compact))
  end
end
