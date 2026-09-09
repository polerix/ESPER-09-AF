CC = clang
CFLAGS = -Wall -Wextra -O2 -fobjc-arc
FRAMEWORKS = -framework Foundation -framework CoreFoundation -framework IOKit
TARGET = bin/orbitcam
SRC = src/orbitcam.m

all: $(TARGET)

$(TARGET): $(SRC)
	@mkdir -p bin
	$(CC) $(CFLAGS) $(SRC) $(FRAMEWORKS) -o $(TARGET)
	@echo "✓ Built $(TARGET)"

clean:
	rm -rf bin
	@echo "✓ Cleaned build artifacts"

install: $(TARGET)
	install -d /usr/local/bin
	install -m 755 $(TARGET) /usr/local/bin/orbitcam
	@echo "✓ Installed orbitcam to /usr/local/bin/orbitcam"

run: $(TARGET)
	./$(TARGET) serve

stop:
	@echo "Stopping existing orbitcam server on port 9090..."
	@-lsof -ti:9090 | xargs kill -9 2>/dev/null || true
	@-pkill -f "bin/orbitcam" 2>/dev/null || true

restart: stop $(TARGET)
	./$(TARGET) serve 9090

.PHONY: all clean install run stop restart
