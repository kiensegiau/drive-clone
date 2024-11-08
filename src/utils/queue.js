class Queue {
  constructor(maxConcurrent = 5) {
    this.items = [];
    this.processing = new Set();
    this.maxConcurrent = maxConcurrent;
  }

  add(item) {
    this.items.push(item);
  }

  async process(handler) {
    while (this.items.length > 0 && this.processing.size < this.maxConcurrent) {
      const item = this.items.shift();
      if (!item) continue;

      this.processing.add(item.id);

      try {
        await handler(item);
      } catch (error) {
        console.error(`❌ Lỗi xử lý item ${item.id}:`, error.message);
      } finally {
        this.processing.delete(item.id);
        this.process(handler);
      }
    }
  }

  size() {
    return this.items.length;
  }

  processingCount() {
    return this.processing.size;
  }
}

module.exports = Queue;
