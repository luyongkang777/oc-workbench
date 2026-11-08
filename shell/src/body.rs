//! 读请求体：带上限和超时。
//!
//! `tiny_http::Request` 的 reader 是阻塞的 socket 读，没有公开的读超时，
//! 所以只能把 `Request` 搬进子线程，主线程用 `recv_timeout` 计时。

use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

/// 转发给上游的请求体上限：工作台只有小的 JSON 写操作，10MB 足够，超过直接 413。
pub const MAX_BODY: usize = 10 * 1024 * 1024;
/// 读请求体的最长等待：客户端声明了长度却发不完时，不能让它一直占着请求线程。
pub const BODY_TIMEOUT: Duration = Duration::from_secs(15);
/// `/api/reconnect` 只需要一个占位 body（前端可能发 `{}`），给个更小的上限。
pub const RECONNECT_BODY_LIMIT: usize = 64 * 1024;

/// 读请求体的结果：超限和读失败要回不同的状态码。
pub enum BodyRead {
    Ok(Vec<u8>),
    TooLarge,
    Failed(std::io::Error),
}

/// 带超时和上限地读请求体。
///
///   * 声明了 `Content-Length` 且超过 `limit` → 不用读，直接判超限；
///   * 读完 → 把 `Request` 还回来（还要用它 respond）；
///   * 超时 → 返回 `None`。此时 `Request` 还留在卡住的读线程里，连接不会被复用，
///     主线程立刻释放并发名额；读线程等客户端断开后自己结束。
pub fn read_body_with_timeout(
    request: tiny_http::Request,
    limit: usize,
) -> Option<(tiny_http::Request, BodyRead)> {
    if let Some(length) = request.body_length() {
        if length > limit {
            return Some((request, BodyRead::TooLarge));
        }
    }

    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut request = request;
        let mut body = Vec::new();
        // 多读 1 字节用来区分「正好等于上限」和「超过上限」。
        let mut reader = std::io::Read::take(request.as_reader(), (limit + 1) as u64);
        let result = match std::io::Read::read_to_end(&mut reader, &mut body) {
            Ok(_) if body.len() > limit => BodyRead::TooLarge,
            Ok(_) => BodyRead::Ok(body),
            Err(err) => BodyRead::Failed(err),
        };
        drop(reader);
        // 主线程已经超时放弃时 send 会失败，Request 随线程结束被丢弃（连接关闭）。
        let _ = sender.send((request, result));
    });

    match receiver.recv_timeout(BODY_TIMEOUT) {
        Ok(pair) => Some(pair),
        Err(RecvTimeoutError::Timeout) => {
            crate::append_log(&format!(
                "[proxy] 读请求体超过 {} 秒仍未结束，放弃该连接\n",
                BODY_TIMEOUT.as_secs()
            ));
            None
        }
        Err(RecvTimeoutError::Disconnected) => {
            crate::append_log("[proxy] 读请求体的线程异常退出，放弃该连接\n");
            None
        }
    }
}
