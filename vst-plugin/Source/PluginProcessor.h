#pragma once

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_dsp/juce_dsp.h>

class EchoDriftAudioProcessor : public juce::AudioProcessor
{
public:
    EchoDriftAudioProcessor();
    ~EchoDriftAudioProcessor() override;

    void prepareToPlay (double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;

    bool isBusesLayoutSupported (const BusesLayout& layouts) const override;

    void processBlock (juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override;

    const juce::String getName() const override;

    bool acceptsMidi() const override;
    bool producesMidi() const override;
    bool isMidiEffect() const override;
    double getTailLengthSeconds() const override;

    int getNumPrograms() override;
    int getCurrentProgram() override;
    void setCurrentProgram (int index) override;
    const juce::String getProgramName (int index) override;
    void changeProgramName (int index, const juce::String& newName) override;

    void getStateInformation (juce::MemoryBlock& destData) override;
    void setStateInformation (const void* data, int sizeInBytes) override;

    juce::AudioProcessorValueTreeState apvts;

    static constexpr auto delayTimeParamId  = "delayTime";
    static constexpr auto feedbackParamId   = "feedback";
    static constexpr auto mixParamId        = "mix";
    static constexpr auto toneParamId       = "tone";

private:
    juce::AudioProcessorValueTreeState::ParameterLayout createParameterLayout();

    static constexpr double maxDelaySeconds = 2.5;

    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> delayLineLeft  { 0 };
    juce::dsp::DelayLine<float, juce::dsp::DelayLineInterpolationTypes::Linear> delayLineRight { 0 };

    juce::dsp::IIR::Filter<float> toneFilterLeft;
    juce::dsp::IIR::Filter<float> toneFilterRight;

    double currentSampleRate = 44100.0;

    juce::LinearSmoothedValue<float> smoothedDelayTime;
    juce::LinearSmoothedValue<float> smoothedFeedback;
    juce::LinearSmoothedValue<float> smoothedMix;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR (EchoDriftAudioProcessor)
};
