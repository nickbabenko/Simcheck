import SwiftUI

@main
struct DemoApp: App {
    var body: some Scene {
        WindowGroup { RootView() }
    }
}

/// A deliberately small app with the shapes a test scenario needs: a login
/// gate, a tab bar, a form control that changes visible state, and a counter.
struct RootView: View {
    @State private var signedIn = false
    var body: some View {
        if signedIn { HomeView() } else { LoginView(signedIn: $signedIn) }
    }
}

struct LoginView: View {
    @Binding var signedIn: Bool
    @State private var email = ""
    @State private var password = ""
    @State private var error: String?

    var body: some View {
        VStack(spacing: 16) {
            Text("Sign in").font(.largeTitle.bold())

            TextField("Email", text: $email)
                .textContentType(.emailAddress)
                .autocapitalization(.none)
                .accessibilityIdentifier("email_field")

            SecureField("Password", text: $password)
                .accessibilityIdentifier("password_field")

            if let error {
                Text(error)
                    .foregroundStyle(.red)
                    .accessibilityIdentifier("login_error")
            }

            Button("Sign In") {
                if email.contains("@") && password.count >= 4 {
                    signedIn = true
                } else {
                    error = "Enter a valid email and a password of at least 4 characters"
                }
            }
            .buttonStyle(.borderedProminent)
            .accessibilityIdentifier("sign_in_button")
        }
        .textFieldStyle(.roundedBorder)
        .padding(24)
    }
}

struct HomeView: View {
    var body: some View {
        TabView {
            CounterView()
                .tabItem { Label("Counter", systemImage: "number") }
                .accessibilityIdentifier("counter_tab")
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gear") }
                .accessibilityIdentifier("settings_tab")
        }
    }
}

struct CounterView: View {
    @State private var count = 0
    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Text("\(count)")
                    .font(.system(size: 72, weight: .bold, design: .rounded))
                    .accessibilityIdentifier("count_label")
                Button("Increment") { count += 1 }
                    .buttonStyle(.borderedProminent)
                    .accessibilityIdentifier("increment_button")
            }
            .navigationTitle("Counter")
        }
    }
}

struct SettingsView: View {
    @AppStorage("notifications") private var notifications = false
    @AppStorage("betaFeatures") private var betaFeatures = false

    var body: some View {
        NavigationStack {
            Form {
                Section("Preferences") {
                    Toggle("Notifications", isOn: $notifications)
                        .accessibilityIdentifier("notifications_toggle")
                    Toggle("Beta Features", isOn: $betaFeatures)
                        .accessibilityIdentifier("beta_toggle")
                }
                Section {
                    Text(betaFeatures ? "Beta features are ON" : "Beta features are OFF")
                        .accessibilityIdentifier("beta_status")
                }
            }
            .navigationTitle("Settings")
        }
    }
}
