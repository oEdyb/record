use std::io::Read;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let response = ureq::builder()
        .try_proxy_from_env(true)
        .build()
        .get("https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.5")
        .call()?;
    assert_eq!(response.status(), 200);
    let mut bytes = Vec::new();
    response.into_reader().take(1024).read_to_end(&mut bytes)?;
    assert!(!bytes.is_empty());
    println!("GitHub HTTPS verified with system roots; read {} bytes", bytes.len());
    Ok(())
}
