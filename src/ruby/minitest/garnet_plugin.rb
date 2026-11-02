# Found by Minitest.load_plugins when Garnet puts this directory on RUBYLIB.
# Active only when $GARNET_TEST_EVENTS is set; writes one JSON object per line for the test results tree.
require "json"

module Minitest
  def self.plugin_garnet_init(options)
    path = ENV["GARNET_TEST_EVENTS"]
    reporter << GarnetReporter.new(path, options) if path && !path.empty?
  end

  class GarnetReporter < AbstractReporter
    def initialize(path, options)
      super()
      @path = path
      @options = options
    end

    def start
      @out = File.open(@path, "a")
      @out.sync = true
      @started = Minitest.clock_time
      emit(event: "start", count: planned)
    end

    def record(result)
      file, line = result.source_location
      klass = result.klass.to_s
      status = result.skipped? ? "pending" : result.passed? ? "passed" : "failed"
      failure = result.failure
      backtrace = failure && !result.skipped? ? Minitest.filter_backtrace(failure.backtrace || []) : nil
      class_line = (Object.const_source_location(klass) rescue nil)
      emit(event: "result", id: "#{klass}##{result.name}", file: file && File.expand_path(file), line: line,
           groups: [{ name: klass, line: (class_line[1] if class_line && class_line[0] == file) }],
           name: result.name, status: status, duration: result.time,
           message: failure && "#{failure.result_label}: #{failure.message}", backtrace: backtrace)
    end

    def report
      emit(event: "done", duration: Minitest.clock_time - @started)
      @out.close
    end

    private

    # Count of tests that will run; nil when a filter Garnet can't evaluate (e.g. Rails line filters) is active.
    def planned
      filter = @options[:filter]
      return nil unless filter.nil? || filter.is_a?(Regexp) || (filter.is_a?(String) && filter.match?(%r{\A/.*/\z}))
      filter = Regexp.new(filter[1..-2]) if filter.is_a?(String)
      Runnable.runnables.sum do |r|
        r.runnable_methods.count { |m| filter.nil? || filter === m || filter === "#{r}##{m}" }
      end
    rescue StandardError
      nil
    end

    def emit(hash)
      @out.puts(JSON.generate(hash.compact))
    end
  end
end
